import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import {
    METADATA_KEY,
    convertCharacterBook,
    loadWorldInfo,
    selected_world_info,
    world_info,
} from '../../../world-info.js';
import { getCharaFilename } from '../../../utils.js';

const MODULE_NAME = 'ai_worldbook_router';
const PROMPT_KEY = 'ai_worldbook_router_prompt';
const LOG_PREFIX = '[AI Worldbook Router]';
const MAX_MVU_CHARS = 1600;
const MAX_RECALL_TERMS = 32;
const MAX_ROUTER_CONTEXT_PREVIEW = 360;
const MAX_BURST_ITEMS = 5;
const MAX_MEMORY_CONTEXT_PREVIEW = 520;
const MEMORY_LINK_TYPES = new Set([
    'INVOLVES', 'PART_OF', 'HAPPENS_AT', 'FOLLOWS', 'UPDATES', 'OPPOSES',
    'ALLIED_WITH', 'CAUSES', 'RELATED', 'MENTIONS',
]);
const FETCH_FALLBACK_ENDPOINTS = [
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
    '/api/horde/generate-text',
];
const COMMON_QUERY_TERMS = new Set([
    '如果', '有人', '这个', '那个', '这里', '那里', '什么', '怎么', '为何', '为什么', '然后',
    '可以', '是不是', '就是', '不是', '一下', '一下子', '这样', '那样', '会被', '会不会',
    '到底', '真的', '已经', '现在', '之前', '之后', '而且', '因为', '所以', '那个地方',
]);

const defaultSystemPrompt = `你是 SillyTavern 的前置世界书路由器。

你的任务：
只根据最近聊天上下文、最后用户消息、可选状态、以及候选条目的 keys，选择本轮真正相关的世界书条目。

必须遵守：
1. 只输出严格 JSON，不要 Markdown，不要代码块，不要解释。
2. 不要输出分析过程，不要输出 reasoning 字段。
3. 不要返回 id，不要返回标题，只返回命中的 key。
4. 只能返回候选条目中实际存在的 key。
5. 如果没有合适条目，返回 {"selected":[]}。
6. 每个 reason 保持简短。

唯一合法输出格式：
{"selected":[{"key":"命中的 key","reason":"简短原因"}]}`;

const defaultSettings = {
    enabled: false,
    debug: false,
    routerUseSeparateModel: false,
    routerApiUrl: '',
    routerApiKey: '',
    routerModel: '',
    routerModels: [],
    routerStatus: '未连接',
    maxCandidates: 24,
    maxSelected: 5,
    maxChars: 4000,
    scanMessages: 8,
    mainHistoryAiTurns: 0,
    memoryEnabled: false,
    memoryAutoRun: true,
    memoryInjectToRouter: true,
    memoryDebug: false,
    memoryScanMessages: 6,
    memoryMaxNodes: 60,
    memoryMaxLinks: 120,
    memoryGraph: null,
    memoryLastTurnSignature: '',
    memoryStatus: '未启用',
    memoryLastPrompt: '',
    memoryLastRaw: '',
    memoryLastError: '',
    keywordRecall: true,
    useMvu: false,
    allowConstant: false,
    titleBlocklist: '',
    position: extension_prompt_types.IN_CHAT,
    depth: 4,
    role: extension_prompt_roles.SYSTEM,
    aiResponseLength: 256,
    routerRetries: 1,
    systemPrompt: defaultSystemPrompt,
};

const settings = structuredClone(defaultSettings);
let lastRun = {
    candidates: [],
    selected: [],
    injectedChars: 0,
    injectionText: '',
    source: 'none',
    error: '',
    routerPrompt: '',
    routerRaw: '',
};
let burstCleanupTimer = null;
let routerBusyPromise = null;
let resolveRouterBusy = null;
let isGenerationActive = false;
let pendingCompatSend = false;
let compatFlushScheduled = false;
let suppressCompatReplay = false;
let compatHooksInstalled = false;
let compatHookRetryTimer = null;
let compatGenerateHookTimer = null;
let isCompatRouterRunning = false;
let isRouterSelectionRequest = false;
let fetchFallbackInstalled = false;
let lastRouteCompletedAt = 0;
let isMemoryWorkerRunning = false;
let memoryUpdateTimer = null;
let memoryGraphView = { x: 0, y: 0, width: 620, height: 300 };
let memoryGraphDrag = null;
let memoryGraphPan = null;
let memoryGraphLinkSourceId = '';

function beginRouterBusy() {
    if (routerBusyPromise) {
        return () => { };
    }

    routerBusyPromise = new Promise((resolve) => {
        resolveRouterBusy = resolve;
    });

    return () => {
        if (!routerBusyPromise) {
            return;
        }

        const resolve = resolveRouterBusy;
        routerBusyPromise = null;
        resolveRouterBusy = null;
        resolve?.();
        scheduleCompatFlush();
    };
}

async function waitForCompatIdle() {
    if (routerBusyPromise) {
        try {
            await routerBusyPromise;
        } catch {
            // no-op
        }
    }

    if (!isGenerationActive) {
        return;
    }

    await new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) {
                return;
            }

            settled = true;
            resolve();
        };

        eventSource.once(event_types.GENERATION_ENDED, done);
        eventSource.once(event_types.GENERATION_STOPPED, done);
    });
}

function scheduleCompatFlush() {
    if (compatFlushScheduled || !pendingCompatSend) {
        return;
    }

    compatFlushScheduled = true;
    (async () => {
        try {
            await waitForCompatIdle();
            await new Promise(resolve => setTimeout(resolve, 250));

            if (!pendingCompatSend || routerBusyPromise || isGenerationActive) {
                return;
            }

            const sendButton = document.getElementById('send_but');
            if (!sendButton) {
                return;
            }

            pendingCompatSend = false;
            suppressCompatReplay = true;
            setTimeout(() => {
                try {
                    sendButton.click();
                } finally {
                    setTimeout(() => {
                        suppressCompatReplay = false;
                    }, 180);
                }
            }, 0);
        } finally {
            compatFlushScheduled = false;
            if (pendingCompatSend && !compatFlushScheduled) {
                scheduleCompatFlush();
            }
        }
    })();
}

function queueCompatSend(event) {
    if (!settings.enabled || suppressCompatReplay || !routerBusyPromise) {
        return false;
    }

    pendingCompatSend = true;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    debugLog('Queued competing send until router idle');
    scheduleCompatFlush();
    return true;
}

function handleCompatTextareaKeydown(event) {
    const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.keyCode === 13;
    if (!isEnter || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
        return;
    }

    queueCompatSend(event);
}

function installCompatSendHooks() {
    try {
        const sendButton = document.getElementById('send_but');
        const textarea = document.getElementById('send_textarea');

        if (sendButton && !sendButton.dataset.aiWbrCompatHook) {
            sendButton.addEventListener('click', queueCompatSend, true);
            sendButton.dataset.aiWbrCompatHook = '1';
        }

        if (textarea && !textarea.dataset.aiWbrCompatHook) {
            textarea.addEventListener('keydown', handleCompatTextareaKeydown, true);
            textarea.dataset.aiWbrCompatHook = '1';
        }

        compatHooksInstalled = !!(sendButton && textarea);
        if (!compatHooksInstalled && !compatHookRetryTimer) {
            compatHookRetryTimer = setTimeout(() => {
                compatHookRetryTimer = null;
                installCompatSendHooks();
            }, 1200);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to install compatibility send hooks`, error);
    }
}

function ensureTavernHelperCompatHook() {
    try {
        const helper = globalThis.TavernHelper;
        const original = helper?.generate;
        if (!helper || typeof original !== 'function' || original.__aiWbrCompatWrapped) {
            return false;
        }

        if (globalThis.original_TavernHelper_generate_ACU?.__aiWbrCompatWrapped) {
            return false;
        }

        const wrapped = async function (...args) {
            if (settings.enabled && !suppressCompatReplay && (routerBusyPromise || isGenerationActive)) {
                debugLog('Waiting for router idle before TavernHelper.generate');
                await waitForCompatIdle();
                await new Promise(resolve => setTimeout(resolve, 250));
            }

            if (settings.enabled && !suppressCompatReplay && !isCompatRouterRunning) {
                const routed = await runTavernHelperRoute(args);
                if (routed) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            return await original.apply(this, args);
        };

        Object.defineProperty(wrapped, '__aiWbrCompatWrapped', {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false,
        });

        helper.generate = wrapped;
        return true;
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to install TavernHelper compatibility hook`, error);
        return false;
    }
}

function startCompatGenerateHookPolling() {
    if (compatGenerateHookTimer) {
        return;
    }

    compatGenerateHookTimer = setInterval(() => {
        try {
            ensureTavernHelperCompatHook();
        } catch (error) {
            console.warn(`${LOG_PREFIX} Compatibility polling failed`, error);
        }
    }, 1500);
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }

    // Deprecated: AI routing is now always on when the plugin itself is enabled.
    if (Object.hasOwn(extension_settings[MODULE_NAME], 'useAi')) {
        delete extension_settings[MODULE_NAME].useAi;
    }

    Object.assign(settings, defaultSettings, extension_settings[MODULE_NAME]);
    if (!settings.memoryGraph || typeof settings.memoryGraph !== 'object') {
        settings.memoryGraph = getDefaultMemoryGraph();
    }
    Object.assign(extension_settings[MODULE_NAME], settings);
}

function saveSetting(key, value) {
    settings[key] = value;
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
}

function setRouterStatus(text) {
    settings.routerStatus = String(text || '未连接');
    $('#ai_wbr_router_status').text(settings.routerStatus);
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
}

function getWorldInfoIcon() {
    return $('#WIDrawerIcon');
}

function ensureFxLayer() {
    let layer = $('#ai_wbr_fx_layer');
    if (layer.length) {
        return layer;
    }

    layer = $('<div id="ai_wbr_fx_layer" aria-hidden="true"></div>');
    $('body').append(layer);
    return layer;
}

function clearEntryBurst() {
    clearTimeout(burstCleanupTimer);
    burstCleanupTimer = null;
    $('#ai_wbr_fx_layer .ai-wbr-entry-burst, #ai_wbr_fx_layer .ai-wbr-status-burst').remove();
}

function startWorldInfoAnimation() {
    const icon = getWorldInfoIcon();
    if (!icon.length) {
        return;
    }

    const layer = ensureFxLayer();
    const anchor = $('#WI-SP-button .drawer-toggle').first();
    const anchorRect = (anchor.length ? anchor[0] : icon[0]).getBoundingClientRect();
    const iconRect = icon[0].getBoundingClientRect();
    let underline = layer.children('.ai-wbr-book-underline');
    if (!underline.length) {
        underline = $('<div class="ai-wbr-book-underline"></div>');
        layer.append(underline);
    }

    underline.css({
        left: `${anchorRect.left + (anchorRect.width / 2)}px`,
        top: `${iconRect.bottom - 44}px`,
    });
}

function stopWorldInfoAnimation() {
    const underline = $('#ai_wbr_fx_layer .ai-wbr-book-underline');
    if (!underline.length) {
        return;
    }

    if (underline.hasClass('ai-wbr-book-underline-error')) {
        setTimeout(() => underline.remove(), 980);
        return;
    }

    underline.remove();
}

function flashWorldInfoError() {
    const underline = $('#ai_wbr_fx_layer .ai-wbr-book-underline');
    if (!underline.length) {
        return;
    }

    underline.removeClass('ai-wbr-book-underline-error');
    void underline[0].offsetWidth;
    underline.addClass('ai-wbr-book-underline-error');
    setTimeout(() => {
        underline.removeClass('ai-wbr-book-underline-error');
    }, 980);
}

function playStatusBurst(symbol, variant = 'retry') {
    const icon = getWorldInfoIcon();
    if (!icon.length) {
        return;
    }

    const layer = ensureFxLayer();
    const rect = icon[0].getBoundingClientRect();
    const burst = $('<div class="ai-wbr-status-burst"></div>')
        .addClass(`ai-wbr-status-burst-${variant}`)
        .text(symbol);

    burst.css({
        left: `${rect.left + (rect.width / 2)}px`,
        top: `${rect.top + (rect.height / 2)}px`,
    });

    layer.append(burst);
    setTimeout(() => burst.remove(), 1050);
}

function getEntryBurstLabel(entry) {
    const comment = String(entry?.comment || '')
        .replace(/^=+\s*/u, '')
        .replace(/\s*=+$/u, '')
        .trim();
    if (comment) {
        return truncateText(comment, 22);
    }

    const key = entry?.matchedKeys?.[0] || entry?.keys?.primary?.[0] || entry?.keys?.all?.[0] || String(entry?.uid || '');
    return truncateText(key, 22);
}

function playSelectedEntriesBurst(entries) {
    const icon = getWorldInfoIcon();
    if (!icon.length || !entries.length) {
        return;
    }

    clearEntryBurst();
    const layer = ensureFxLayer();
    const rect = icon[0].getBoundingClientRect();
    const originX = rect.left + (rect.width / 2);
    const originY = rect.top + (rect.height / 2);
    const burstEntries = entries.slice(0, MAX_BURST_ITEMS);

    burstEntries.forEach((entry, index) => {
        const chip = $('<div class="ai-wbr-entry-burst"></div>').text(getEntryBurstLabel(entry));
        const direction = index % 2 === 0 ? -1 : 1;
        const spreadX = direction * (44 + (index * 18));
        const spreadY = 54 + (index * 12);
        const tilt = direction * (10 + (index * 4));
        chip.css({
            left: `${originX}px`,
            top: `${originY}px`,
            '--burst-x': `${spreadX}px`,
            '--burst-y': `${spreadY}px`,
            '--burst-tilt': `${tilt}deg`,
            '--burst-delay': `${index * 70}ms`,
        });
        layer.append(chip);
    });

    burstCleanupTimer = setTimeout(() => {
        clearEntryBurst();
    }, 1900);
}

function normalizeText(value) {
    return String(value ?? '').toLowerCase();
}

function extractActualUserInput(value) {
    const text = String(value ?? '');
    const match = text.match(/<本轮用户输入>\s*([\s\S]*?)\s*<\/本轮用户输入>/i);
    return (match ? match[1] : text).trim();
}

function escapeRegex(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}

function truncateText(value, maxLength) {
    const text = String(value ?? '').trim();
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean).map(value => String(value)))];
}

function splitIntoSentences(text) {
    return String(text ?? '')
        .split(/(?<=[.!?。！？\n])/u)
        .map(part => part.trim())
        .filter(Boolean);
}

function extractQueryTerms(...texts) {
    const terms = [];

    for (const rawText of texts) {
        const text = String(rawText ?? '').trim();
        if (!text) {
            continue;
        }

        const latinTokens = text
            .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
            .split(/\s+/)
            .map(token => token.trim())
            .filter(token => token.length >= 3);
        terms.push(...latinTokens);

        const hanChunks = text.match(/[\p{Script=Han}]{2,}/gu) || [];
        for (const chunk of hanChunks) {
            if (chunk.length <= 4) {
                terms.push(chunk);
                continue;
            }

            for (let size = 4; size >= 2; size -= 1) {
                for (let index = 0; index <= chunk.length - size; index += 1) {
                    terms.push(chunk.slice(index, index + size));
                }
            }
        }
    }

    return uniqueStrings(terms
        .map(normalizeText)
        .filter(term => term.length >= 2)
        .filter(term => !COMMON_QUERY_TERMS.has(term)))
        .slice(0, MAX_RECALL_TERMS);
}

function countTermHits(text, term) {
    if (!text || !term) {
        return 0;
    }

    const matches = text.match(new RegExp(escapeRegex(term), 'gu'));
    return matches?.length ?? 0;
}

function normalizeUrl(value) {
    return String(value ?? '').trim().replace(/\/+$/, '');
}

function parseBlockRules(value) {
    return String(value ?? '')
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean);
}

function matchesBlockRule(text, rule) {
    const source = String(text ?? '');
    const rawRule = String(rule ?? '').trim();
    if (!source || !rawRule) {
        return false;
    }

    const regexMatch = rawRule.match(/^\/(.+)\/([a-z]*)$/iu);
    if (regexMatch) {
        try {
            return new RegExp(regexMatch[1], regexMatch[2]).test(source);
        } catch {
            return false;
        }
    }

    return normalizeText(source).includes(normalizeText(rawRule));
}

function getBlockedTitleRule(entry) {
    const comment = String(entry?.comment || '').trim();
    if (!comment) {
        return '';
    }

    return parseBlockRules(settings.titleBlocklist).find(rule => matchesBlockRule(comment, rule)) || '';
}

function getEntryId(entry, fallback) {
    return entry.uid ?? entry.id ?? entry.displayIndex ?? fallback;
}

function getEntryKeys(entry) {
    const primary = Array.isArray(entry.key) ? entry.key : (Array.isArray(entry.keys) ? entry.keys : []);
    const secondary = Array.isArray(entry.keysecondary)
        ? entry.keysecondary
        : (Array.isArray(entry.secondary_keys) ? entry.secondary_keys : []);
    const triggers = Array.isArray(entry.triggers) ? entry.triggers : [];
    return {
        primary: primary.map(String).filter(Boolean),
        secondary: secondary.map(String).filter(Boolean),
        all: [...primary, ...secondary, ...triggers].map(String).filter(Boolean),
    };
}

function getRecentMessages(chat) {
    return chat
        .filter(message => message && !message.is_system && message.mes)
        .slice(-settings.scanMessages)
        .map(message => ({
            name: message.name || '',
            text: message.is_user ? extractActualUserInput(message.mes) : String(message.mes || ''),
            isUser: !!message.is_user,
        }));
}

function getTavernHelperInput(options) {
    if (!options || typeof options !== 'object') {
        return '';
    }

    const injected = Array.isArray(options.injects)
        ? options.injects.find(entry => entry && typeof entry.content === 'string' && entry.content.trim())?.content
        : '';

    return String(
        injected
        || options.user_input
        || options.prompt
        || options.message
        || ''
    );
}

function buildCompatRecentMessages(context, options) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const recentMessages = getRecentMessages(chat);
    const input = extractActualUserInput(getTavernHelperInput(options));

    if (!input) {
        return recentMessages;
    }

    const last = recentMessages[recentMessages.length - 1];
    if (last?.isUser && last.text.trim() === input) {
        return recentMessages;
    }

    return [
        ...recentMessages,
        {
            name: context?.name1 || 'User',
            text: input,
            isUser: true,
        },
    ].slice(-settings.scanMessages);
}

function shouldRouteTavernHelperGenerate(options) {
    if (!options || typeof options !== 'object') {
        return false;
    }

    if (options._ai_wbr_routed) {
        return false;
    }

    if (options.quiet_prompt || options.quiet || options.automatic_trigger) {
        return false;
    }

    return !!extractActualUserInput(getTavernHelperInput(options));
}

function getFetchUrl(input) {
    if (typeof input === 'string') {
        return input;
    }

    if (input instanceof URL) {
        return input.pathname;
    }

    return String(input?.url || '');
}

function isMainGenerationFetch(input, init) {
    if (isRouterSelectionRequest) {
        return false;
    }

    const url = getFetchUrl(input);
    if (!FETCH_FALLBACK_ENDPOINTS.some(endpoint => url.includes(endpoint))) {
        return false;
    }

    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    return method === 'POST';
}

function contentToText(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') {
                    return part;
                }

                return part?.text || part?.content || '';
            })
            .filter(Boolean)
            .join('\n');
    }

    return content == null ? '' : String(content);
}

function getPayloadBody(init) {
    return typeof init?.body === 'string' ? init.body : '';
}

function buildFetchFallbackMessages(context, payload) {
    if (Array.isArray(payload?.messages) && payload.messages.length) {
        return payload.messages
            .map(message => ({
                name: message.name || message.role || '',
                text: message.role === 'user' ? extractActualUserInput(contentToText(message.content)) : contentToText(message.content),
                isUser: message.role === 'user',
            }))
            .filter(message => message.text)
            .slice(-settings.scanMessages);
    }

    const chat = Array.isArray(context?.chat) ? getRecentMessages(context.chat) : [];
    if (chat.length) {
        return chat;
    }

    if (typeof payload?.prompt === 'string' && payload.prompt.trim()) {
        return [{
            name: context?.name1 || 'User',
            text: extractActualUserInput(payload.prompt),
            isUser: true,
        }];
    }

    return [];
}

function injectIntoGenerationPayload(payload, injection) {
    if (!injection) {
        return false;
    }

    if (Array.isArray(payload.messages)) {
        payload.messages.unshift({
            role: 'system',
            content: injection,
        });
        return true;
    }

    if (typeof payload.prompt === 'string') {
        payload.prompt = `${injection}\n\n${payload.prompt}`;
        return true;
    }

    return false;
}

function trimMainGenerationMessages(messages) {
    if (!Array.isArray(messages)) {
        return { changed: false, trimmedCount: 0 };
    }

    const maxAssistantTurns = clampNumber(settings.mainHistoryAiTurns, 0, 0, 100);
    if (maxAssistantTurns <= 0) {
        return { changed: false, trimmedCount: 0 };
    }

    const assistantIndexes = [];
    for (let index = 0; index < messages.length; index += 1) {
        if (String(messages[index]?.role || '').toLowerCase() === 'assistant') {
            assistantIndexes.push(index);
        }
    }

    if (assistantIndexes.length <= maxAssistantTurns) {
        return { changed: false, trimmedCount: 0 };
    }

    let startIndex = assistantIndexes[assistantIndexes.length - maxAssistantTurns];
    while (startIndex > 0 && String(messages[startIndex - 1]?.role || '').toLowerCase() === 'user') {
        startIndex -= 1;
    }

    const trimmedMessages = messages.filter((message, index) => {
        const role = String(message?.role || '').toLowerCase();
        if (role !== 'user' && role !== 'assistant') {
            return true;
        }

        return index >= startIndex;
    });

    const trimmedCount = messages.length - trimmedMessages.length;
    if (trimmedCount <= 0) {
        return { changed: false, trimmedCount: 0 };
    }

    messages.splice(0, messages.length, ...trimmedMessages);
    return { changed: true, trimmedCount };
}

function installFetchFallbackHook() {
    if (fetchFallbackInstalled || typeof globalThis.fetch !== 'function') {
        return;
    }

    const originalFetch = globalThis.fetch.bind(globalThis);
    const wrappedFetch = async function (input, init = undefined) {
        if (!settings.enabled || !isMainGenerationFetch(input, init)) {
            return originalFetch(input, init);
        }

        const body = getPayloadBody(init);
        if (!body) {
            return originalFetch(input, init);
        }

        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            return originalFetch(input, init);
        }

        const context = getContext();
        const recentMessages = buildFetchFallbackMessages(context, payload);
        const trimResult = trimMainGenerationMessages(payload.messages);
        const shouldSkipRouting = body.includes('[本轮相关世界书]') || Date.now() - lastRouteCompletedAt < 3000;

        if (shouldSkipRouting) {
            if (trimResult.changed) {
                debugLog('Trimmed main generation history without rerouting', {
                    url: getFetchUrl(input),
                    trimmedCount: trimResult.trimmedCount,
                    remainingMessages: payload.messages?.length ?? 0,
                });
                return originalFetch(input, {
                    ...init,
                    body: JSON.stringify(payload),
                });
            }

            return originalFetch(input, init);
        }

        const endRouterBusy = beginRouterBusy();
        clearEntryBurst();
        startWorldInfoAnimation();

        try {
            if (!recentMessages.length) {
                return originalFetch(input, trimResult.changed ? {
                    ...init,
                    body: JSON.stringify(payload),
                } : init);
            }

            const result = await routeWorldbookForMessages(context, recentMessages, 'fetch_fallback', {
                type: 'fetch',
                url: getFetchUrl(input),
            });

            if (result.selected.length && !result.source.includes('fallback')) {
                playSelectedEntriesBurst(result.selected);
            }

            if (!injectIntoGenerationPayload(payload, result.injection)) {
                return originalFetch(input, init);
            }

            debugLog('Injected through fetch fallback', {
                url: getFetchUrl(input),
                selected: result.selected.length,
                chars: result.injection.length,
                trimmedCount: trimResult.trimmedCount,
            });

            return originalFetch(input, {
                ...init,
                body: JSON.stringify(payload),
            });
        } catch (error) {
            debugError(error);
            console.error(`${LOG_PREFIX} Fetch fallback failed`, error);
            return originalFetch(input, init);
        } finally {
            stopWorldInfoAnimation();
            endRouterBusy();
        }
    };

    Object.defineProperty(wrappedFetch, '__aiWbrFetchWrapped', {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });

    globalThis.fetch = wrappedFetch;
    fetchFallbackInstalled = true;
}

function getLastUserMessage(recentMessages) {
    const text = [...recentMessages].reverse().find(message => message.isUser)?.text
        || recentMessages.at(-1)?.text
        || '';
    return extractActualUserInput(text);
}

function summarizeMvuValue(value) {
    if (value === undefined || value === null || value === '') {
        return '';
    }

    if (typeof value === 'string') {
        return truncateText(value, MAX_MVU_CHARS);
    }

    try {
        return truncateText(JSON.stringify(value, null, 2), MAX_MVU_CHARS);
    } catch {
        return truncateText(String(value), MAX_MVU_CHARS);
    }
}

function findNestedStatData(value, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || depth > 4) {
        return null;
    }

    if (seen.has(value)) {
        return null;
    }
    seen.add(value);

    if (Object.hasOwn(value, 'stat_data')) {
        return value.stat_data;
    }

    for (const child of Object.values(value)) {
        const found = findNestedStatData(child, depth + 1, seen);
        if (found !== null && found !== undefined) {
            return found;
        }
    }

    return null;
}

function readVariableStore(store, keys) {
    if (!store?.get) {
        return '';
    }

    for (const key of keys) {
        try {
            const value = store.get(key);
            const summary = summarizeMvuValue(value);
            if (summary) {
                return summary;
            }
        } catch {
            // Some variable providers throw for missing keys.
        }
    }

    return '';
}

function getMvuSummary(context) {
    if (!settings.useMvu) {
        return '';
    }

    const directMetadata = summarizeMvuValue(context.chatMetadata?.stat_data);
    if (directMetadata) {
        return directMetadata;
    }

    const nestedMetadata = summarizeMvuValue(findNestedStatData(context.chatMetadata));
    if (nestedMetadata) {
        return nestedMetadata;
    }

    const keys = ['stat_data', 'mvu_stat_data', 'tavern_helper_stat_data', 'MVU.stat_data'];
    const localVariable = readVariableStore(context.variables?.local, keys);
    if (localVariable) {
        return localVariable;
    }

    const globalVariable = readVariableStore(context.variables?.global, keys);
    if (globalVariable) {
        return globalVariable;
    }

    for (const value of [
        globalThis.TavernHelper?.stat_data,
        globalThis.TavernHelper?.statData,
        globalThis.MVU?.stat_data,
        globalThis.MVU?.statData,
        globalThis.stat_data,
    ]) {
        const summary = summarizeMvuValue(value);
        if (summary) {
            return summary;
        }
    }

    return '';
}

function getDefaultMemoryGraph() {
    return {
        version: 1,
        state: {
            current_location: '',
            current_objective: '',
            active_topics: [],
            open_questions: [],
        },
        nodes: [],
        links: [],
        lastSummary: '',
        updatedAt: '',
    };
}

function getMemoryGraph() {
    if (!settings.memoryGraph || typeof settings.memoryGraph !== 'object') {
        settings.memoryGraph = getDefaultMemoryGraph();
    }

    const graph = settings.memoryGraph;
    graph.version = Number(graph.version || 1);
    graph.state = {
        ...getDefaultMemoryGraph().state,
        ...(graph.state && typeof graph.state === 'object' ? graph.state : {}),
    };
    graph.state.active_topics = uniqueStrings(Array.isArray(graph.state.active_topics) ? graph.state.active_topics : []);
    graph.state.open_questions = uniqueStrings(Array.isArray(graph.state.open_questions) ? graph.state.open_questions : []);
    graph.nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    graph.links = Array.isArray(graph.links) ? graph.links : [];
    graph.lastSummary = String(graph.lastSummary || '');
    graph.updatedAt = String(graph.updatedAt || '');
    return graph;
}

function saveMemoryGraph(graph = getMemoryGraph()) {
    settings.memoryGraph = graph;
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
    renderMemoryPanel();
}

function setMemoryStatus(text) {
    settings.memoryStatus = String(text || '');
    $('#ai_wbr_memory_status').text(settings.memoryStatus);
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
}

function createMemoryId(title, fallback = 'memory') {
    const base = String(title || fallback)
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/gu, '')
        .slice(0, 42);
    return base || `${fallback}_${Date.now().toString(36)}`;
}

function normalizeMemoryNode(rawNode, fallbackIndex = 0) {
    const title = truncateText(rawNode?.title || rawNode?.label || rawNode?.id || `记忆 ${fallbackIndex + 1}`, 80);
    return {
        id: createMemoryId(rawNode?.id || title, `node_${fallbackIndex + 1}`),
        title,
        type: truncateText(rawNode?.type || 'event', 32),
        content: truncateText(rawNode?.content || rawNode?.description || '', 1200),
        tags: uniqueStrings(Array.isArray(rawNode?.tags)
            ? rawNode.tags
            : String(rawNode?.tags || '').split(/[,\n，、]+/u)),
        importance: clampNumber(rawNode?.importance, 0.6, 0, 1),
        credibility: clampNumber(rawNode?.credibility, 0.8, 0, 1),
        updatedAt: new Date().toISOString(),
    };
}

function normalizeMemoryLink(rawLink, nodeIds, fallbackIndex = 0) {
    const source = createMemoryId(rawLink?.source || rawLink?.sourceId || rawLink?.from || '');
    const target = createMemoryId(rawLink?.target || rawLink?.targetId || rawLink?.to || '');
    if (!source || !target || source === target || !nodeIds.has(source) || !nodeIds.has(target)) {
        return null;
    }

    const type = String(rawLink?.type || rawLink?.label || 'RELATED').trim().toUpperCase();
    return {
        id: truncateText(rawLink?.id || `${source}_${type}_${target}_${fallbackIndex}`, 120),
        source,
        target,
        type: MEMORY_LINK_TYPES.has(type) ? type : 'RELATED',
        weight: clampNumber(rawLink?.weight, 0.7, 0, 1),
        description: truncateText(rawLink?.description || rawLink?.reason || '', 480),
        updatedAt: new Date().toISOString(),
    };
}

function getRecentMessagesByCount(chat, count) {
    const limit = clampNumber(count, 6, 2, 40);
    return chat
        .filter(message => message && !message.is_system && message.mes)
        .slice(-limit)
        .map(message => ({
            name: message.name || '',
            text: message.is_user ? extractActualUserInput(message.mes) : String(message.mes || ''),
            isUser: !!message.is_user,
        }));
}

function getMemoryTurnSignature(recentMessages) {
    return recentMessages
        .slice(-4)
        .map(message => `${message.isUser ? 'U' : 'A'}:${message.name}:${truncateText(message.text, 240)}`)
        .join('\n---\n');
}

function buildMemoryRouterSummary() {
    if (!settings.memoryInjectToRouter) {
        return '';
    }

    const graph = getMemoryGraph();
    const state = graph.state || {};
    const topNodes = [...graph.nodes]
        .sort((a, b) => (Number(b.importance || 0) - Number(a.importance || 0)))
        .slice(0, 8)
        .map(node => `- ${node.title} (${node.type || 'memory'}): ${truncateText(node.content, 160)}`)
        .join('\n');
    const topLinks = graph.links
        .slice(-8)
        .map(link => {
            const source = graph.nodes.find(node => node.id === link.source)?.title || link.source;
            const target = graph.nodes.find(node => node.id === link.target)?.title || link.target;
            return `- ${source} ${link.type || 'RELATED'} ${target}${link.description ? `：${truncateText(link.description, 90)}` : ''}`;
        })
        .join('\n');

    const parts = [
        '[轻量记忆状态]',
        state.current_location ? `当前地点：${state.current_location}` : '',
        state.current_objective ? `当前目标：${state.current_objective}` : '',
        state.active_topics?.length ? `活跃主题：${state.active_topics.join('、')}` : '',
        state.open_questions?.length ? `未解问题：${state.open_questions.join('、')}` : '',
        graph.lastSummary ? `最近摘要：${truncateText(graph.lastSummary, 420)}` : '',
        topNodes ? `关键记忆节点：\n${topNodes}` : '',
        topLinks ? `关键关系：\n${topLinks}` : '',
        '[/轻量记忆状态]',
    ].filter(Boolean);

    return parts.length > 2 ? truncateText(parts.join('\n'), MAX_MVU_CHARS) : '';
}

function getCombinedStateSummary(context) {
    return [getMvuSummary(context), buildMemoryRouterSummary()].filter(Boolean).join('\n\n');
}

function getMemoryExtractionSchema() {
    return {
        name: 'ai_worldbook_memory_graph_update',
        value: {
            type: 'object',
            additionalProperties: true,
            properties: {
                state: { type: 'object' },
                nodes: { type: 'array', items: { type: 'object' } },
                updates: { type: 'array', items: { type: 'object' } },
                links: { type: 'array', items: { type: 'object' } },
                remove_node_ids: { type: 'array', items: { type: 'string' } },
                remove_link_ids: { type: 'array', items: { type: 'string' } },
                summary: { type: 'string' },
            },
        },
        strict: false,
    };
}

function buildMemoryExtractionPrompt(recentMessages, graph) {
    const recentContext = recentMessages
        .map(message => `${message.name || (message.isUser ? 'User' : 'Assistant')}: ${truncateText(message.text, MAX_MEMORY_CONTEXT_PREVIEW)}`)
        .join('\n\n');
    const currentGraph = truncateText(JSON.stringify({
        state: graph.state,
        nodes: graph.nodes.slice(-24),
        links: graph.links.slice(-36),
    }, null, 2), 4200);

    return `你是 SillyTavern 的后置轻量记忆图谱整理器。

目标：从“最近对话”里提取对长期角色扮演/剧情推进有价值的信息，并以结构化 JSON 更新记忆图谱。

必须保存：
- 如果本轮出现了剧情推进、角色互动、地点变化、任务变化、世界观设定、重要承诺、冲突、发现、战斗、交易、关系变化，至少创建 1 个 event/quest/character/location 节点。
- 角色扮演和故事场景里，即使只是“一段互动”，只要会影响后续扮演，也应保存为压缩事件节点。

优先保存：
- 已确认的角色、地点、势力、物品、规则、任务、关键事件。
- 当前地点、当前目标、活跃主题、未解问题。
- 有明确证据的关系边。

不要保存：
- 普通常识、纯格式说明、无内容寒暄、纯风格描写、未发生的计划、没有证据的猜测。
- 与已有节点语义相同的新节点；这种情况用 updates。

现有记忆图谱：
${currentGraph || '{}'}

最近对话：
${recentContext || '(空)'}

严禁返回 JSON 对象、严禁返回 {content:{}}、严禁返回 Markdown。
你必须只返回下面这个“变量块”，字段名一字不差，所有右侧内容都必须是**单行 JSON 值**：

[[AIWBR_MEMORY_VARS_BEGIN]]
memory_state_current_location_json=""
memory_state_current_objective_json=""
memory_active_topics_json=[]
memory_open_questions_json=[]
memory_nodes_json=[]
memory_updates_json=[]
memory_links_json=[]
memory_remove_node_ids_json=[]
memory_remove_link_ids_json=[]
memory_summary_json=""
[[AIWBR_MEMORY_VARS_END]]

规则：
1. 以上 10 行必须全部输出，顺序不要变。
2. 每行等号右边必须是合法 JSON 值：
   - 字符串用 "..."
   - 数组用 [...]
3. 如果没有内容，字符串填 ""，数组填 []。
4. nodes_json 中每个节点格式：
   {"id":"稳定英文或拼音id","title":"简短标题","type":"event|character|location|faction|item|concept|rule|quest","content":"已确认事实","tags":["标签"],"importance":0.6,"credibility":0.8}
5. links_json 中每个关系格式：
   {"source":"源节点id或标题","target":"目标节点id或标题","type":"INVOLVES|PART_OF|HAPPENS_AT|FOLLOWS|UPDATES|OPPOSES|ALLIED_WITH|CAUSES|RELATED","weight":0.7,"description":"关系证据"}
6. 如果最近对话存在剧情推进/角色互动/设定变化，memory_nodes_json 不能为空。
7. memory_summary_json 必须概括本轮为什么值得写入记忆；只有确实没有长期价值时才允许是 ""。
8. 不要输出任何解释、前后缀、代码块、额外字段。

请开始输出变量块。`;
}

function parseMemoryUpdate(rawResponse, prompt = '') {
    const parseMemoryVariableBlock = (text) => {
        const raw = String(text || '');
        if (!raw.trim()) {
            return null;
        }

        const blockMatch = raw.match(/\[\[AIWBR_MEMORY_VARS_BEGIN\]\]([\s\S]*?)\[\[AIWBR_MEMORY_VARS_END\]\]/u);
        const body = (blockMatch ? blockMatch[1] : raw).trim();
        if (!body.includes('memory_nodes_json=') && !body.includes('memory_summary_json=')) {
            return null;
        }

        const lines = body
            .split(/\r?\n/u)
            .map(line => line.trim())
            .filter(Boolean);

        const values = {};
        for (const line of lines) {
            const index = line.indexOf('=');
            if (index <= 0) {
                continue;
            }
            const key = line.slice(0, index).trim();
            const valueText = line.slice(index + 1).trim();
            values[key] = valueText;
        }

        const readJsonValue = (key, fallback) => {
            const valueText = values[key];
            if (valueText === undefined) {
                return fallback;
            }
            try {
                return JSON.parse(valueText);
            } catch {
                return fallback;
            }
        };

        return {
            state: {
                current_location: readJsonValue('memory_state_current_location_json', ''),
                current_objective: readJsonValue('memory_state_current_objective_json', ''),
                active_topics: readJsonValue('memory_active_topics_json', []),
                open_questions: readJsonValue('memory_open_questions_json', []),
            },
            nodes: readJsonValue('memory_nodes_json', []),
            updates: readJsonValue('memory_updates_json', []),
            links: readJsonValue('memory_links_json', []),
            remove_node_ids: readJsonValue('memory_remove_node_ids_json', []),
            remove_link_ids: readJsonValue('memory_remove_link_ids_json', []),
            summary: readJsonValue('memory_summary_json', ''),
        };
    };

    const looksLikeMemoryPayload = (value) => {
        return value && typeof value === 'object' && !Array.isArray(value) && (
            value.state !== undefined
            || value.nodes !== undefined
            || value.updates !== undefined
            || value.links !== undefined
            || value.summary !== undefined
        );
    };

    if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
        if (looksLikeMemoryPayload(rawResponse)) {
            return rawResponse;
        }

        if (looksLikeMemoryPayload(rawResponse.content)) {
            return rawResponse.content;
        }

        if (looksLikeMemoryPayload(rawResponse.message?.content)) {
            return rawResponse.message.content;
        }

        if (looksLikeMemoryPayload(rawResponse.choices?.[0]?.message?.content)) {
            return rawResponse.choices[0].message.content;
        }
    }

    const texts = collectRouterResponseTexts(rawResponse);
    for (const text of texts) {
        const variableParsed = parseMemoryVariableBlock(text);
        if (variableParsed) {
            return variableParsed;
        }
        const parsed = tryParseSelectionText(text);
        if (parsed && !Array.isArray(parsed)) {
            return parsed;
        }
        const rawText = String(text || '').trim();
        const withoutFence = rawText.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        const firstBrace = withoutFence.indexOf('{');
        const lastBrace = withoutFence.lastIndexOf('}');
        const candidates = [
            withoutFence,
            firstBrace >= 0 && lastBrace > firstBrace ? withoutFence.slice(firstBrace, lastBrace + 1) : '',
        ].filter(Boolean);
        for (const candidate of candidates) {
            try {
                return JSON.parse(candidate);
            } catch {
                // keep trying
            }
        }
    }

    if (typeof rawResponse === 'string') {
        const variableParsed = parseMemoryVariableBlock(rawResponse);
        if (variableParsed) {
            return variableParsed;
        }
    }

    const error = new Error(`Memory graph JSON parse failed. Preview: ${truncateText(texts.join(' '), 220) || '(empty)'}`);
    error.routerPrompt = prompt;
    error.routerRaw = summarizeRouterResponse(rawResponse);
    throw error;
}

function resolveMemoryNodeId(value, graph) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }
    const direct = createMemoryId(raw);
    if (graph.nodes.some(node => node.id === direct)) {
        return direct;
    }
    const byTitle = graph.nodes.find(node => normalizeText(node.title) === normalizeText(raw));
    return byTitle?.id || direct;
}

function applyMemoryGraphUpdate(update) {
    const graph = getMemoryGraph();
    const now = new Date().toISOString();
    let addedOrUpdatedNodeCount = 0;

    const state = update?.state && typeof update.state === 'object' ? update.state : {};
    if (typeof state.current_location === 'string') {
        graph.state.current_location = truncateText(state.current_location, 120);
    }
    if (typeof state.current_objective === 'string') {
        graph.state.current_objective = truncateText(state.current_objective, 180);
    }
    if (Array.isArray(state.active_topics)) {
        graph.state.active_topics = uniqueStrings([...state.active_topics]).slice(0, 12);
    }
    if (Array.isArray(state.open_questions)) {
        graph.state.open_questions = uniqueStrings([...state.open_questions]).slice(0, 12);
    }

    const removeNodeIds = new Set((Array.isArray(update?.remove_node_ids) ? update.remove_node_ids : []).map(createMemoryId));
    if (removeNodeIds.size) {
        graph.nodes = graph.nodes.filter(node => !removeNodeIds.has(node.id));
        graph.links = graph.links.filter(link => !removeNodeIds.has(link.source) && !removeNodeIds.has(link.target));
    }

    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    const incomingNodes = Array.isArray(update?.nodes) ? update.nodes : [];
    for (const rawNode of incomingNodes.slice(0, 8)) {
        const node = normalizeMemoryNode(rawNode, byId.size);
        const existing = byId.get(node.id) || graph.nodes.find(item => normalizeText(item.title) === normalizeText(node.title));
        if (existing) {
            Object.assign(existing, {
                ...existing,
                title: node.title || existing.title,
                type: node.type || existing.type,
                content: node.content || existing.content,
                tags: uniqueStrings([...(existing.tags || []), ...(node.tags || [])]),
                importance: Math.max(Number(existing.importance || 0), Number(node.importance || 0)),
                credibility: Math.max(Number(existing.credibility || 0), Number(node.credibility || 0)),
                updatedAt: now,
            });
            byId.set(existing.id, existing);
            addedOrUpdatedNodeCount += 1;
        } else {
            graph.nodes.push(node);
            byId.set(node.id, node);
            addedOrUpdatedNodeCount += 1;
        }
    }

    const updates = Array.isArray(update?.updates) ? update.updates : [];
    for (const rawUpdate of updates.slice(0, 8)) {
        const resolvedId = resolveMemoryNodeId(rawUpdate?.id || rawUpdate?.title || rawUpdate?.titleToUpdate, graph);
        const existing = byId.get(resolvedId) || graph.nodes.find(item => normalizeText(item.title) === normalizeText(rawUpdate?.title || rawUpdate?.titleToUpdate || ''));
        if (!existing) {
            continue;
        }
        if (rawUpdate.title) {
            existing.title = truncateText(rawUpdate.title, 80);
        }
        if (rawUpdate.content || rawUpdate.newContent) {
            existing.content = truncateText(rawUpdate.content || rawUpdate.newContent, 1400);
        }
        if (rawUpdate.importance !== undefined) {
            existing.importance = clampNumber(rawUpdate.importance, existing.importance || 0.6, 0, 1);
        }
        if (rawUpdate.credibility !== undefined) {
            existing.credibility = clampNumber(rawUpdate.credibility, existing.credibility || 0.8, 0, 1);
        }
        existing.updatedAt = now;
        addedOrUpdatedNodeCount += 1;
    }

    if (!addedOrUpdatedNodeCount && typeof update?.summary === 'string' && update.summary.trim()) {
        const fallbackTitle = truncateText(update.summary.trim().split(/[。.!?\n]/u)[0] || '本轮关键事件', 48);
        const fallbackNode = normalizeMemoryNode({
            id: `event_${Date.now().toString(36)}`,
            title: fallbackTitle,
            type: 'event',
            content: update.summary.trim(),
            tags: ['自动摘要'],
            importance: 0.55,
            credibility: 0.75,
        }, byId.size);
        graph.nodes.push(fallbackNode);
        byId.set(fallbackNode.id, fallbackNode);
    }

    graph.nodes = graph.nodes
        .sort((a, b) => (Number(b.importance || 0) - Number(a.importance || 0)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, clampNumber(settings.memoryMaxNodes, 60, 5, 200));

    const nodeIds = new Set(graph.nodes.map(node => node.id));
    const removeLinkIds = new Set((Array.isArray(update?.remove_link_ids) ? update.remove_link_ids : []).map(value => String(value)));
    graph.links = graph.links.filter(link => !removeLinkIds.has(String(link.id)) && nodeIds.has(link.source) && nodeIds.has(link.target));

    const incomingLinks = Array.isArray(update?.links) ? update.links : [];
    const existingLinkKeys = new Set(graph.links.map(link => `${link.source}|${link.type}|${link.target}`));
    for (const rawLink of incomingLinks.slice(0, 12)) {
        const normalized = normalizeMemoryLink({
            ...rawLink,
            source: resolveMemoryNodeId(rawLink?.source || rawLink?.sourceId || rawLink?.from, graph),
            target: resolveMemoryNodeId(rawLink?.target || rawLink?.targetId || rawLink?.to, graph),
        }, nodeIds, graph.links.length);
        if (!normalized) {
            continue;
        }
        const key = `${normalized.source}|${normalized.type}|${normalized.target}`;
        const existing = graph.links.find(link => `${link.source}|${link.type}|${link.target}` === key);
        if (existing) {
            existing.weight = Math.max(Number(existing.weight || 0), Number(normalized.weight || 0));
            existing.description = normalized.description || existing.description;
            existing.updatedAt = now;
            continue;
        }
        if (!existingLinkKeys.has(key)) {
            graph.links.push(normalized);
            existingLinkKeys.add(key);
        }
    }

    graph.links = graph.links
        .filter(link => nodeIds.has(link.source) && nodeIds.has(link.target))
        .slice(-clampNumber(settings.memoryMaxLinks, 120, 0, 400));
    if (typeof update?.summary === 'string' && update.summary.trim()) {
        graph.lastSummary = truncateText(update.summary, 900);
    }
    graph.updatedAt = now;
    saveMemoryGraph(graph);
    return graph;
}

function startMemoryAnimation() {
    const icon = getWorldInfoIcon();
    if (!icon.length) {
        return;
    }

    const layer = ensureFxLayer();
    const rect = icon[0].getBoundingClientRect();
    let pulse = layer.children('.ai-wbr-memory-orbit');
    if (!pulse.length) {
        pulse = $('<div class="ai-wbr-memory-orbit"><span></span><span></span><span></span></div>');
        layer.append(pulse);
    }
    pulse.css({
        left: `${rect.left + (rect.width / 2)}px`,
        top: `${rect.top + (rect.height / 2)}px`,
    });
}

function stopMemoryAnimation(success = true) {
    const pulse = $('#ai_wbr_fx_layer .ai-wbr-memory-orbit');
    if (!pulse.length) {
        return;
    }
    pulse.toggleClass('ai-wbr-memory-orbit-done', !!success);
    setTimeout(() => pulse.remove(), success ? 720 : 120);
}

async function runMemoryGraphUpdate(reason = 'auto') {
    if (!settings.memoryEnabled || isMemoryWorkerRunning || isRouterSelectionRequest) {
        return false;
    }

    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const recentMessages = getRecentMessagesByCount(chat, settings.memoryScanMessages);
    if (recentMessages.length < 2) {
        return false;
    }

    const signature = getMemoryTurnSignature(recentMessages);
    if (reason === 'auto' && signature && signature === settings.memoryLastTurnSignature) {
        return false;
    }

    isMemoryWorkerRunning = true;
    startMemoryAnimation();
    setMemoryStatus('记忆整理中...');

    try {
        const graph = getMemoryGraph();
        const prompt = buildMemoryExtractionPrompt(recentMessages, graph);
        settings.memoryLastPrompt = prompt;
        settings.memoryLastRaw = '';
        settings.memoryLastError = '';
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        const memorySystemPrompt = '你是严格 JSON 输出的长期记忆图谱整理器。不要输出 Markdown，不要解释。';
        let raw;
        try {
            isRouterSelectionRequest = true;
            if (settings.routerUseSeparateModel && settings.routerApiUrl && settings.routerApiKey && settings.routerModel) {
                raw = await sendSeparateModelWithFallback(context, prompt, {
                    systemPrompt: memorySystemPrompt,
                    maxTokens: 1024,
                    jsonSchema: undefined,
                });
            } else {
                raw = await context.generateRaw({
                    prompt,
                    systemPrompt: memorySystemPrompt,
                    responseLength: 1024,
                    trimNames: false,
                });
            }
        } finally {
            isRouterSelectionRequest = false;
        }
        settings.memoryLastRaw = summarizeRouterResponse(raw);
        settings.memoryLastError = '';
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        const update = parseMemoryUpdate(raw, prompt);
        applyMemoryGraphUpdate(update);
        settings.memoryLastTurnSignature = signature;
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        const nodeCount = getMemoryGraph().nodes.length;
        const linkCount = getMemoryGraph().links.length;
        setMemoryStatus(`已更新：${nodeCount} 节点 / ${linkCount} 关系`);
        playStatusBurst('✦', 'memory');
        stopMemoryAnimation(true);
        return true;
    } catch (error) {
        console.warn(`${LOG_PREFIX} Memory graph update failed`, error);
        settings.memoryLastError = error?.message || String(error);
        if (error?.routerRaw && !settings.memoryLastRaw) {
            settings.memoryLastRaw = error.routerRaw;
        }
        if (error?.routerPrompt && !settings.memoryLastPrompt) {
            settings.memoryLastPrompt = error.routerPrompt;
        }
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        setMemoryStatus(`记忆失败：${truncateText(error?.message || error, 80)}`);
        playStatusBurst('×', 'fail');
        stopMemoryAnimation(false);
        return false;
    } finally {
        isMemoryWorkerRunning = false;
        renderMemoryPanel();
    }
}

function scheduleMemoryGraphUpdate() {
    if (!settings.memoryEnabled || !settings.memoryAutoRun) {
        return;
    }
    clearTimeout(memoryUpdateTimer);
    memoryUpdateTimer = setTimeout(() => {
        runMemoryGraphUpdate('auto');
    }, 900);
}

function normalizeWorldEntry(rawEntry, source, worldName, index) {
    const id = getEntryId(rawEntry, index);
    return {
        ...rawEntry,
        routerId: `${source}:${worldName || 'embedded'}:${id}`,
        uid: id,
        source,
        world: worldName || '',
        comment: String(rawEntry.comment || rawEntry.memo || ''),
        content: String(rawEntry.content || ''),
        constant: !!rawEntry.constant,
        disable: !!rawEntry.disable || rawEntry.enabled === false,
        order: Number(rawEntry.order ?? rawEntry.insertion_order ?? 0),
        keys: getEntryKeys(rawEntry),
    };
}

function worldEntriesFromData(data, source, worldName) {
    if (!data?.entries) {
        return [];
    }

    const entries = Array.isArray(data.entries) ? data.entries : Object.values(data.entries);
    return entries.map((entry, index) => normalizeWorldEntry(entry, source, worldName, index));
}

async function getEmbeddedCharacterEntries(context) {
    const character = context.characters?.[context.characterId];
    const book = character?.data?.character_book;
    if (!book?.entries?.length) {
        return [];
    }

    const converted = convertCharacterBook(book);
    return worldEntriesFromData(converted, 'character_book', book.name || character?.name || 'embedded');
}

async function getLinkedWorldEntries(context) {
    const character = context.characters?.[context.characterId];
    const worldSources = new Map();

    const addWorld = (worldName, source) => {
        if (worldName && !worldSources.has(worldName)) {
            worldSources.set(worldName, source);
        }
    };

    for (const worldName of selected_world_info || []) {
        addWorld(worldName, 'global_world');
    }

    addWorld(context.chatMetadata?.[METADATA_KEY], 'chat_world');
    addWorld(character?.data?.extensions?.world, 'character_world');
    addWorld(context.powerUserSettings?.persona_description_lorebook, 'persona_world');

    try {
        const fileName = context.characterId !== undefined ? getCharaFilename(context.characterId) : '';
        const extraCharLore = world_info.charLore?.find(entry => entry.name === fileName);
        for (const worldName of extraCharLore?.extraBooks || []) {
            addWorld(worldName, 'character_extra_world');
        }
    } catch (error) {
        debugLog('Could not read character extra world bindings', error);
    }

    const allEntries = [];
    for (const [worldName, source] of worldSources.entries()) {
        try {
            const data = await loadWorldInfo(worldName);
            allEntries.push(...worldEntriesFromData(data, source, worldName));
        } catch (error) {
            console.warn(`${LOG_PREFIX} Failed to load world info "${worldName}"`, error);
        }
    }

    return allEntries;
}

async function getWorldbookEntries(context) {
    const [embedded, linked] = await Promise.all([
        getEmbeddedCharacterEntries(context),
        getLinkedWorldEntries(context),
    ]);

    const deduped = [];
    const seen = new Set();
    for (const entry of [...embedded, ...linked]) {
        const key = `${entry.world}:${entry.uid}:${entry.content}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(entry);
    }

    return deduped;
}

function scoreEntry(entry, matchText, lastUserText, recentText) {
    let score = 0;
    const matchedKeys = new Set();
    const matchedSignals = new Set();
    const lowerMatchText = normalizeText(matchText);
    const lowerLastUserText = normalizeText(lastUserText);
    const comment = normalizeText(entry.comment);
    const content = normalizeText(truncateText(entry.content, 2400));
    const haystack = `${comment}\n${content}`;

    for (const key of entry.keys.primary) {
        const normalized = normalizeText(key).trim();
        if (normalized && lowerMatchText.includes(normalized)) {
            score += lowerLastUserText.includes(normalized) ? 14 : 10;
            matchedKeys.add(key);
        }
    }

    for (const key of entry.keys.secondary) {
        const normalized = normalizeText(key).trim();
        if (normalized && lowerMatchText.includes(normalized)) {
            score += lowerLastUserText.includes(normalized) ? 6 : 4;
            matchedKeys.add(key);
        }
    }

    if (comment && lowerLastUserText && comment.includes(lowerLastUserText.slice(0, 16))) {
        score += 2;
    }

    const lastUserTerms = extractQueryTerms(lastUserText);
    const recentTerms = extractQueryTerms(recentText);

    for (const term of lastUserTerms) {
        const hits = countTermHits(haystack, term);
        if (!hits) {
            continue;
        }

        matchedSignals.add(term);
        if (term.length >= 4) {
            score += 6;
        } else if (term.length === 3) {
            score += 4;
        } else {
            score += 2;
        }
    }

    for (const term of recentTerms) {
        if (lastUserTerms.includes(term)) {
            continue;
        }

        const hits = countTermHits(haystack, term);
        if (!hits) {
            continue;
        }

        matchedSignals.add(term);
        score += term.length >= 3 ? 2 : 1;
    }

    if (!matchedKeys.size && matchedSignals.size && lowerLastUserText.includes('魔法') && haystack.includes('魔法')) {
        score += 2;
    }

    if (entry.constant) {
        score -= 3;
    }

    return { score, matchedKeys: [...matchedKeys], matchedSignals: [...matchedSignals] };
}

function recallCandidates(entries, recentMessages, mvuSummary) {
    const lastUserMessage = getLastUserMessage(recentMessages);
    const recentText = recentMessages.map(message => `${message.name}: ${message.text}`).join('\n');
    const matchText = [lastUserMessage, recentText, mvuSummary].filter(Boolean).join('\n\n');

    const candidates = entries
        .filter(entry => entry.content && !entry.disable)
        .filter(entry => settings.allowConstant || !entry.constant)
        .filter(entry => !getBlockedTitleRule(entry))
        .map(entry => {
            const { score, matchedKeys, matchedSignals } = scoreEntry(entry, matchText, lastUserMessage, recentText);
            return { ...entry, score, matchedKeys, matchedSignals };
        });

    return candidates
        .sort((a, b) => {
            const aMatched = a.score > 0 ? 1 : 0;
            const bMatched = b.score > 0 ? 1 : 0;
            return (bMatched - aMatched) || (b.score - a.score) || (b.order - a.order);
        })
        .slice(0, settings.maxCandidates);
}

function buildAiPrompt(recentMessages, mvuSummary, candidates) {
    const lastUserMessage = getLastUserMessage(recentMessages);
    const recentContext = recentMessages
        .map(message => `${message.name || (message.isUser ? 'User' : 'Assistant')}: ${truncateText(message.text, MAX_ROUTER_CONTEXT_PREVIEW)}`)
        .join('\n\n');
    const candidateText = candidates.map(entry => {
        const keys = entry.keys.all.length ? entry.keys.all.join(' / ') : '(无 keys)';
        return `- ${keys}`;
    }).join('\n');

    return `选择最多 ${settings.maxSelected} 条本轮相关世界书。

最后用户消息：
${lastUserMessage || '(空)'}

最近上下文：
${recentContext || '(空)'}

MVU/stat_data：
${mvuSummary || '(未启用或未读取到)'}

候选 keys（每行一条）：
${candidateText || '(无)'}

如果没有合适条目，返回 {"selected":[]}
只输出严格 JSON：{"selected":[{"key":"命中的 key","reason":"选择原因"}]}`;
}

function getSelectionSchema() {
    return {
        name: 'ai_worldbook_router_selection',
        value: {
            type: 'object',
            additionalProperties: false,
            properties: {
                selected: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            key: { type: 'string' },
                            reason: { type: 'string' },
                        },
                        required: ['key', 'reason'],
                    },
                },
            },
            required: ['selected'],
        },
        strict: true,
    };
}

function normalizeSelectionPayload(payload) {
    const selected = payload?.selected
        ?? payload?.content?.selected
        ?? payload?.message?.content?.selected;

    if (!Array.isArray(selected)) {
        throw new Error('AI selection JSON is missing selected[] or content.selected[]');
    }

    return selected;
}

function getEntrySelectionKeys(entry) {
    return uniqueStrings(entry.keys.all.map(key => String(key).trim()).filter(Boolean));
}

function splitSelectionKey(value) {
    return uniqueStrings(String(value ?? '')
        .split(/[\/|,，、；;\n]+/u)
        .map(part => part.trim())
        .filter(Boolean));
}

function resolveEntryFromSelection(item, byId, byKey, candidates) {
    const id = String(item?.id ?? '').trim();
    if (id) {
        const entryById = byId.get(id);
        if (entryById) {
            return entryById;
        }
    }

    const rawKey = String(item?.key ?? '').trim();
    if (!rawKey) {
        return null;
    }

    const parts = splitSelectionKey(rawKey);
    for (const part of parts) {
        const entryByKey = byKey.get(normalizeText(part));
        if (entryByKey) {
            return entryByKey;
        }
    }

    const normalizedRawKey = normalizeText(rawKey);
    if (!normalizedRawKey) {
        return null;
    }

    for (const candidate of candidates) {
        const candidateKeys = getEntrySelectionKeys(candidate);
        if (candidateKeys.some(key => normalizedRawKey.includes(normalizeText(key)))) {
            return candidate;
        }
    }

    return null;
}

function tryParseSelectionText(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
        return null;
    }

    const withoutFence = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const candidates = [withoutFence];
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.unshift(withoutFence.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of uniqueStrings(candidates)) {
        try {
            return normalizeSelectionPayload(JSON.parse(candidate));
        } catch {
            // Keep trying alternative text slices.
        }
    }

    return null;
}

function collectRouterResponseTexts(rawResponse) {
    if (rawResponse === null || rawResponse === undefined) {
        return [];
    }

    if (typeof rawResponse === 'string') {
        return [rawResponse];
    }

    const texts = [];
    const stack = [rawResponse];
    const seen = new WeakSet();

    while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') {
            continue;
        }

        if (seen.has(current)) {
            continue;
        }
        seen.add(current);

        for (const [key, value] of Object.entries(current)) {
            if (typeof value === 'string' && (
                key === 'content'
                || key === 'reasoning_content'
                || key === 'text'
                || key === 'output_text'
            )) {
                texts.push(value);
            } else if (value && typeof value === 'object') {
                stack.push(value);
            }
        }
    }

    return uniqueStrings(texts.map(text => text.trim()).filter(Boolean));
}

function stripReasoningForDisplay(text) {
    return String(text ?? '')
        .replace(/,\s*"reasoning"\s*:\s*"[\s\S]*?"(?=\s*[},])/gu, ', "reasoning":"[filtered]"')
        .replace(/,\s*"reasoning_content"\s*:\s*"[\s\S]*?"(?=\s*[},])/gu, ', "reasoning_content":"[filtered]"')
        .replace(/"reasoning"\s*:\s*"[\s\S]*?"(?=\s*[},])/gu, '"reasoning":"[filtered]"')
        .replace(/"reasoning_content"\s*:\s*"[\s\S]*?"(?=\s*[},])/gu, '"reasoning_content":"[filtered]"');
}

function summarizeRouterResponse(rawResponse) {
    if (rawResponse === null || rawResponse === undefined) {
        return '(empty)';
    }

    if (typeof rawResponse === 'string') {
        return stripReasoningForDisplay(rawResponse);
    }

    try {
        return stripReasoningForDisplay(JSON.stringify(rawResponse, null, 2));
    } catch {
        const texts = collectRouterResponseTexts(rawResponse);
        if (texts.length) {
            return stripReasoningForDisplay(texts.join('\n\n---\n\n'));
        }

        return stripReasoningForDisplay(String(rawResponse));
    }
}

function createSelectionParseError(rawResponse, previewText = '', prompt = '') {
    const error = new Error(`AI selection JSON parse failed. Preview: ${truncateText(previewText, 220) || '(empty)'}`);
    error.routerPrompt = prompt;
    error.routerRaw = summarizeRouterResponse(rawResponse);
    return error;
}

function extractSelectionFromText(rawText, candidates) {
    const text = String(rawText || '');
    if (!text) {
        return [];
    }

    const normalizedText = normalizeText(text);
    const sentences = splitIntoSentences(text);
    const positiveMarkers = [
        'this is it', 'that is the answer', 'that\'s the answer', 'bingo', 'perfect match',
        'exact match', 'exactly', 'direct answer', 'most relevant', 'best match',
        '正是', '就是这个', '答案', '最相关', '完全匹配', '直接回答',
    ];
    const negativeMarkers = [
        'irrelevant', 'not relevant', 'no,', ' no ', 'not the answer', 'indirectly relevant',
        'just a natural event', 'not what happens after', 'not about', '不相关', '不是答案',
        '不是这个', '无关', '只是', '不对',
    ];
    const recovered = [];

    for (const candidate of candidates) {
        const entryKeys = getEntrySelectionKeys(candidate);
        let score = 0;

        for (const key of entryKeys) {
            const normalizedKey = normalizeText(key);
            const keyPattern = new RegExp(`["']?(?:key|keys?)["']?\\s*[:=]\\s*["']?${escapeRegex(key)}["']?`, 'u');
            if (keyPattern.test(text)) {
                score += 8;
            }
            if (normalizedKey && normalizedText.includes(normalizedKey)) {
                score += normalizedKey.length >= 3 ? 4 : 2;
            }
        }

        if (!score) {
            continue;
        }

        for (const sentence of sentences) {
            const normalizedSentence = normalizeText(sentence);
            const mentionsCandidate = entryKeys.some(key => {
                const normalizedKey = normalizeText(key);
                return normalizedKey && normalizedSentence.includes(normalizedKey);
            });
            if (!mentionsCandidate) {
                continue;
            }

            for (const marker of positiveMarkers) {
                if (normalizedSentence.includes(marker)) {
                    score += 6;
                }
            }
            for (const marker of negativeMarkers) {
                if (normalizedSentence.includes(marker)) {
                    score -= 5;
                }
            }
        }

        recovered.push({
            key: entryKeys[0] || '',
            reason: 'Recovered from router response text.',
            recoveryScore: score,
        });
    }

    const positives = recovered
        .filter(item => item.recoveryScore > 0)
        .sort((a, b) => b.recoveryScore - a.recoveryScore);

    if (!positives.length) {
        return [];
    }

    const strongestScore = positives[0].recoveryScore;
    const threshold = Math.max(6, strongestScore - 2);
    return positives
        .filter(item => item.recoveryScore >= threshold)
        .slice(0, 2)
        .map(({ recoveryScore, ...item }) => item);
}

function parseSelectionJson(rawResponse, candidates = [], prompt = '') {
    if (rawResponse && typeof rawResponse === 'object') {
        try {
            return normalizeSelectionPayload(rawResponse);
        } catch {
            // Fall through to text extraction / recovery for provider-specific wrappers.
        }
    }

    const texts = collectRouterResponseTexts(rawResponse);
    for (const text of texts) {
        const parsed = tryParseSelectionText(text);
        if (parsed) {
            return parsed;
        }
    }

    const recovered = extractSelectionFromText(texts.join('\n\n'), candidates);
    if (recovered.length) {
        return recovered;
    }

    throw createSelectionParseError(rawResponse, texts.join(' '), prompt);
}

function getRouterMessages(prompt, systemPrompt = settings.systemPrompt) {
    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
    ];
}

function isEffectivelyEmptyStructuredResponse(rawResponse) {
    if (rawResponse == null) {
        return true;
    }

    if (typeof rawResponse === 'string') {
        return !rawResponse.trim();
    }

    if (typeof rawResponse !== 'object') {
        return false;
    }

    const content = rawResponse.content;
    if (content && typeof content === 'object' && !Array.isArray(content) && !Object.keys(content).length) {
        return true;
    }

    const texts = collectRouterResponseTexts(rawResponse);
    if (!texts.length && !Object.keys(rawResponse).length) {
        return true;
    }

    return false;
}

function getSeparateModelRequestData(context, prompt, {
    systemPrompt = settings.systemPrompt,
    maxTokens = Math.max(settings.aiResponseLength, 384),
    jsonSchema = getSelectionSchema(),
} = {}) {
    return context.ChatCompletionService.createRequestData({
        stream: false,
        messages: getRouterMessages(prompt, systemPrompt),
        model: settings.routerModel,
        chat_completion_source: 'openai',
        max_tokens: maxTokens,
        temperature: 0,
        reverse_proxy: normalizeUrl(settings.routerApiUrl),
        proxy_password: String(settings.routerApiKey || ''),
        json_schema: jsonSchema,
    });
}

async function sendSeparateModelWithFallback(context, prompt, {
    systemPrompt = settings.systemPrompt,
    maxTokens = Math.max(settings.aiResponseLength, 384),
    jsonSchema = getSelectionSchema(),
} = {}) {
    const sendOnce = async (schema) => {
        const requestData = getSeparateModelRequestData(context, prompt, {
            systemPrompt,
            maxTokens,
            jsonSchema: schema,
        });

        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {}),
            },
            cache: 'no-cache',
            body: JSON.stringify(requestData),
        });

        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    };

    let raw = await sendOnce(jsonSchema);
    if (!isEffectivelyEmptyStructuredResponse(raw)) {
        return raw;
    }

    return await sendOnce(undefined);
}

function getRouterRequestData(context, prompt) {
    return getSeparateModelRequestData(context, prompt, {
        systemPrompt: settings.systemPrompt,
        maxTokens: Math.max(settings.aiResponseLength, 384),
        jsonSchema: getSelectionSchema(),
    });
}

async function selectWithSeparateRouterModel(context, recentMessages, mvuSummary, candidates) {
    const prompt = buildAiPrompt(recentMessages, mvuSummary, candidates);
    const result = await sendSeparateModelWithFallback(context, prompt, {
        systemPrompt: settings.systemPrompt,
        maxTokens: Math.max(settings.aiResponseLength, 384),
        jsonSchema: getSelectionSchema(),
    });
    const parsed = parseSelectionJson(result, candidates, prompt);
    return {
        parsed,
        prompt,
        rawPreview: summarizeRouterResponse(result),
    };
}

async function runSingleAiSelectionAttempt(context, recentMessages, mvuSummary, candidates) {
    let parsed;
    let prompt = '';
    let rawPreview = '';
    if (settings.routerUseSeparateModel && settings.routerApiUrl && settings.routerApiKey && settings.routerModel) {
        const result = await selectWithSeparateRouterModel(context, recentMessages, mvuSummary, candidates);
        parsed = result.parsed;
        prompt = result.prompt;
        rawPreview = result.rawPreview;
    } else {
        prompt = buildAiPrompt(recentMessages, mvuSummary, candidates);
        const raw = await context.generateRaw({
            prompt,
            systemPrompt: settings.systemPrompt,
            responseLength: settings.aiResponseLength,
            trimNames: false,
            jsonSchema: getSelectionSchema(),
        });
        parsed = parseSelectionJson(raw, candidates, prompt);
        rawPreview = summarizeRouterResponse(raw);
    }

    return { parsed, prompt, rawPreview };
}

async function selectWithAi(context, recentMessages, mvuSummary, candidates) {
    if (candidates.length === 0) {
        return {
            selected: [],
            prompt: '',
            rawPreview: '',
        };
    }

    const maxAttempts = Math.max(1, Number(settings.routerRetries || 0) + 1);
    let parsed;
    let prompt = '';
    let rawPreview = '';
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const result = await runSingleAiSelectionAttempt(context, recentMessages, mvuSummary, candidates);
            parsed = result.parsed;
            prompt = result.prompt;
            rawPreview = result.rawPreview;
            break;
        } catch (error) {
            lastError = error;
            prompt = error?.routerPrompt || prompt || '';
            rawPreview = error?.routerRaw || rawPreview || error?.message || String(error);
            debugLog(`Router attempt ${attempt}/${maxAttempts} failed`, error);

            if (attempt < maxAttempts) {
                playStatusBurst('🔄', 'retry');
                continue;
            }

            playStatusBurst('×', 'fail');
            flashWorldInfoError();
            throw error;
        }
    }

    if (!parsed) {
        throw lastError || new Error('Router selection failed without parsed result.');
    }

    const byId = new Map();
    const byKey = new Map();
    for (const entry of candidates) {
        byId.set(String(entry.routerId), entry);
        byId.set(String(entry.uid), entry);
        for (const key of getEntrySelectionKeys(entry)) {
            const normalizedKey = normalizeText(key);
            if (normalizedKey && !byKey.has(normalizedKey)) {
                byKey.set(normalizedKey, entry);
            }
        }
    }
    const selected = [];
    const seen = new Set();

    for (const item of parsed) {
        const entry = resolveEntryFromSelection(item, byId, byKey, candidates);
        if (!entry || seen.has(entry.routerId)) {
            continue;
        }

        seen.add(entry.routerId);
        selected.push({
            ...entry,
            reason: truncateText(item.reason || 'AI selected this entry.', 240),
        });

        if (selected.length >= settings.maxSelected) {
            break;
        }
    }

    return {
        selected,
        prompt,
        rawPreview,
    };
}

function selectWithFallback(candidates) {
    return candidates.slice(0, settings.maxSelected).map(entry => ({
        ...entry,
        reason: entry.matchedKeys?.length
            ? `关键词命中：${entry.matchedKeys.join(', ')}`
            : `关键词评分 fallback：${entry.score}`,
    }));
}

function buildInjection(selectedEntries) {
    if (!selectedEntries.length) {
        return '';
    }

    const header = '[本轮相关世界书]\n以下条目由前置路由器按当前用户消息、最近上下文和可选状态筛选，仅用于本轮回复保持设定一致。\n';
    const footer = '\n[/本轮相关世界书]';
    const parts = [header];
    let used = header.length + footer.length;

    for (const entry of selectedEntries) {
        const title = entry.comment || entry.keys.primary[0] || entry.uid;
        const separator = `\n--- ${title} | ${entry.world || entry.source}#${entry.uid} ---\n`;
        const remaining = settings.maxChars - used - separator.length - footer.length;
        if (remaining <= 0) {
            break;
        }

        const content = truncateText(entry.content, remaining);
        parts.push(separator, content, '\n');
        used += separator.length + content.length + 1;
    }

    parts.push(footer);
    return truncateText(parts.join(''), settings.maxChars);
}

function renderDebugPanel() {
    const summary = lastRun.error
        ? `失败：${lastRun.error}`
        : `候选 ${lastRun.candidates.length} 条，选择 ${lastRun.selected.length} 条，注入 ${lastRun.injectedChars} 字符，来源：${lastRun.source}`;
    $('#ai_wbr_last_summary').text(summary);

    const items = lastRun.selected.map(entry => {
        const title = entry.comment || entry.keys?.primary?.[0] || entry.uid;
        const keys = entry.matchedKeys?.length ? ` | keys: ${entry.matchedKeys.join(', ')}` : '';
        return $('<div class="ai-wbr-last-item"></div>')
            .append($('<div></div>').text(`${title} (${entry.world || entry.source}#${entry.uid})`))
            .append($('<small></small>').text(`${entry.reason || ''}${keys}`));
    });

    $('#ai_wbr_last_items').empty().append(items);
    $('#ai_wbr_injection_text').text(lastRun.injectionText || '尚无本轮注入记录');
    $('#ai_wbr_router_prompt').text(lastRun.routerPrompt || '尚无前置 AI Prompt 记录');
    $('#ai_wbr_router_raw').text(lastRun.routerRaw || '尚无前置 AI 返回记录');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeCssSelector(value) {
    const text = String(value ?? '');
    if (globalThis.CSS?.escape) {
        return CSS.escape(text);
    }

    return text.replace(/["\\]/g, '\\$&');
}

function renderMemoryGraphSvg(graph) {
    const container = $('#ai_wbr_memory_graph');
    if (!container.length) {
        return;
    }

    const nodes = graph.nodes.slice(0, 18);
    if (!nodes.length) {
        container.html('<div class="ai-wbr-token-empty">暂无记忆节点。生成回复后会自动整理，或点击“立即整理本轮”。</div>');
        return;
    }

    const width = 620;
    const height = 300;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(120, 42 + nodes.length * 7);
    const positions = new Map();
    nodes.forEach((node, index) => {
        if (Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y))) {
            positions.set(node.id, {
                x: Number(node.x),
                y: Number(node.y),
            });
            return;
        }

        const angle = (Math.PI * 2 * index / nodes.length) - Math.PI / 2;
        node.x = centerX + Math.cos(angle) * radius;
        node.y = centerY + Math.sin(angle) * radius;
        positions.set(node.id, {
            x: node.x,
            y: node.y,
        });
    });

    const visibleIds = new Set(nodes.map(node => node.id));
    const edges = graph.links.filter(link => visibleIds.has(link.source) && visibleIds.has(link.target)).slice(-32);
    const lines = edges.map(link => {
        const source = positions.get(link.source);
        const target = positions.get(link.target);
        if (!source || !target) {
            return '';
        }
        const opacity = Math.max(0.22, Math.min(0.85, Number(link.weight || 0.5)));
        return `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" class="ai-wbr-memory-edge" data-source-id="${escapeHtml(link.source)}" data-target-id="${escapeHtml(link.target)}" style="opacity:${opacity}"><title>${escapeHtml(link.type || 'RELATED')}</title></line>`;
    }).join('');

    const circles = nodes.map(node => {
        const position = positions.get(node.id);
        const colorClass = `ai-wbr-memory-node-${escapeHtml(String(node.type || 'event').toLowerCase())}`;
        return `<g class="ai-wbr-memory-node ${colorClass}" data-memory-node-id="${escapeHtml(node.id)}" transform="translate(${position.x},${position.y})">
            <circle r="${24 + (Number(node.importance || 0.5) * 10)}"></circle>
            <text y="${40 + (Number(node.importance || 0.5) * 5)}">${escapeHtml(truncateText(node.title, 16))}</text>
            <title>${escapeHtml(`${node.title}\n${node.content || ''}`)}</title>
        </g>`;
    }).join('');

    if (!memoryGraphView || !Number.isFinite(memoryGraphView.width)) {
        memoryGraphView = { x: 0, y: 0, width, height };
    }

    container.html(`
        <div class="ai-wbr-memory-graph-toolbar">
            <button class="menu_button ai-wbr-memory-zoom-in" type="button">＋</button>
            <button class="menu_button ai-wbr-memory-zoom-out" type="button">－</button>
            <button class="menu_button ai-wbr-memory-zoom-reset" type="button">重置视图</button>
            <span class="ai-wbr-memory-link-hint">${memoryGraphLinkSourceId ? `连线起点：${escapeHtml(graph.nodes.find(node => node.id === memoryGraphLinkSourceId)?.title || memoryGraphLinkSourceId)}` : '点击节点可编辑/连线，拖动节点可调整位置，滚轮缩放'}</span>
        </div>
        <svg viewBox="${memoryGraphView.x} ${memoryGraphView.y} ${memoryGraphView.width} ${memoryGraphView.height}" role="img" aria-label="记忆图谱">${lines}${circles}</svg>
    `);
    bindMemoryGraphSvgInteractions();
}

function getMemoryGraphSvgPoint(svg, clientX, clientY) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
}

function updateMemoryGraphViewBox(svg) {
    svg.setAttribute('viewBox', `${memoryGraphView.x} ${memoryGraphView.y} ${memoryGraphView.width} ${memoryGraphView.height}`);
}

function showMemoryNodePopover(nodeId, clientX, clientY) {
    const graph = getMemoryGraph();
    const node = graph.nodes.find(item => item.id === nodeId);
    let popover = $('#ai_wbr_memory_node_popover');
    if (!popover.length) {
        popover = $('<div id="ai_wbr_memory_node_popover" class="ai-wbr-memory-node-popover"></div>');
        $('body').append(popover);
    }
    if (!node || !popover.length) {
        return;
    }

    const sourceTitle = memoryGraphLinkSourceId
        ? graph.nodes.find(item => item.id === memoryGraphLinkSourceId)?.title || memoryGraphLinkSourceId
        : '';

    popover
        .attr('data-memory-node-id', node.id)
        .html(`
            <div class="ai-wbr-memory-popover-title">${escapeHtml(truncateText(node.title || node.id, 38))}</div>
            <label>标题<input class="text_pole" type="text" data-popover-node-field="title" value="${escapeHtml(node.title || '')}" /></label>
            <label>类型<input class="text_pole" type="text" data-popover-node-field="type" value="${escapeHtml(node.type || 'event')}" /></label>
            <label>内容<textarea class="text_pole" rows="2" data-popover-node-field="content">${escapeHtml(node.content || '')}</textarea></label>
            <div class="ai-wbr-memory-popover-actions">
                <button class="menu_button ai-wbr-memory-popover-save" type="button">保存</button>
                <button class="menu_button ai-wbr-memory-set-link-source" type="button">设为起点</button>
                <button class="menu_button ai-wbr-memory-link-to-source" type="button" ${memoryGraphLinkSourceId && memoryGraphLinkSourceId !== node.id ? '' : 'disabled'}>连接到起点${sourceTitle ? `：${escapeHtml(truncateText(sourceTitle, 8))}` : ''}</button>
                <button class="menu_button ai-wbr-memory-popover-delete" type="button">删除</button>
            </div>
        `)
        .css({
            left: `${Math.min(Math.max(clientX + 12, 8), window.innerWidth - 244)}px`,
            top: `${Math.min(Math.max(clientY + 12, 8), window.innerHeight - 210)}px`,
        })
        .show();
}

function bindMemoryGraphSvgInteractions() {
    const container = $('#ai_wbr_memory_graph');
    const svg = container.find('svg')[0];
    if (!svg) {
        return;
    }

    container.off('.memoryGraphSvg');
    $(document).off('.memoryGraphSvg');

    container.on('wheel.memoryGraphSvg', 'svg', function (event) {
        event.preventDefault();
        const original = event.originalEvent;
        const svgPoint = getMemoryGraphSvgPoint(svg, original.clientX, original.clientY);
        const factor = original.deltaY < 0 ? 0.88 : 1.14;
        const nextWidth = Math.min(1400, Math.max(120, memoryGraphView.width * factor));
        const nextHeight = Math.min(900, Math.max(80, memoryGraphView.height * factor));
        const ratioX = (svgPoint.x - memoryGraphView.x) / memoryGraphView.width;
        const ratioY = (svgPoint.y - memoryGraphView.y) / memoryGraphView.height;
        memoryGraphView = {
            x: svgPoint.x - (nextWidth * ratioX),
            y: svgPoint.y - (nextHeight * ratioY),
            width: nextWidth,
            height: nextHeight,
        };
        updateMemoryGraphViewBox(svg);
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-zoom-in', () => {
        memoryGraphView.width = Math.max(120, memoryGraphView.width * 0.82);
        memoryGraphView.height = Math.max(80, memoryGraphView.height * 0.82);
        updateMemoryGraphViewBox(svg);
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-zoom-out', () => {
        memoryGraphView.width = Math.min(1400, memoryGraphView.width * 1.18);
        memoryGraphView.height = Math.min(900, memoryGraphView.height * 1.18);
        updateMemoryGraphViewBox(svg);
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-zoom-reset', () => {
        memoryGraphView = { x: 0, y: 0, width: 620, height: 300 };
        updateMemoryGraphViewBox(svg);
    });

    container.on('mousedown.memoryGraphSvg', '.ai-wbr-memory-node', function (event) {
        const nodeId = String($(this).data('memoryNodeId'));
        const start = getMemoryGraphSvgPoint(svg, event.clientX, event.clientY);
        const graph = getMemoryGraph();
        const node = graph.nodes.find(item => item.id === nodeId);
        if (!node) {
            return;
        }
        memoryGraphDrag = {
            nodeId,
            startX: start.x,
            startY: start.y,
            nodeX: Number(node.x || 0),
            nodeY: Number(node.y || 0),
            moved: false,
        };
        event.preventDefault();
        event.stopPropagation();
    });

    container.on('mousedown.memoryGraphSvg', 'svg', function (event) {
        if ($(event.target).closest('.ai-wbr-memory-node').length) {
            return;
        }

        memoryGraphPan = {
            startClientX: event.clientX,
            startClientY: event.clientY,
            viewX: memoryGraphView.x,
            viewY: memoryGraphView.y,
            moved: false,
        };
        $('#ai_wbr_memory_node_popover').hide();
        $(svg).addClass('ai-wbr-memory-panning');
        event.preventDefault();
    });

    $(document).on('mousemove.memoryGraphSvg', (event) => {
        if (!memoryGraphDrag) {
            if (memoryGraphPan) {
                const rect = svg.getBoundingClientRect();
                const dx = (event.clientX - memoryGraphPan.startClientX) * (memoryGraphView.width / Math.max(1, rect.width));
                const dy = (event.clientY - memoryGraphPan.startClientY) * (memoryGraphView.height / Math.max(1, rect.height));
                if (Math.abs(dx) + Math.abs(dy) > 1.5) {
                    memoryGraphPan.moved = true;
                }
                memoryGraphView.x = memoryGraphPan.viewX - dx;
                memoryGraphView.y = memoryGraphPan.viewY - dy;
                updateMemoryGraphViewBox(svg);
            }
            return;
        }
        const point = getMemoryGraphSvgPoint(svg, event.clientX, event.clientY);
        const dx = point.x - memoryGraphDrag.startX;
        const dy = point.y - memoryGraphDrag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 1.5) {
            memoryGraphDrag.moved = true;
        }
        const graph = getMemoryGraph();
        const node = graph.nodes.find(item => item.id === memoryGraphDrag.nodeId);
        if (!node) {
            return;
        }
        node.x = memoryGraphDrag.nodeX + dx;
        node.y = memoryGraphDrag.nodeY + dy;
        const group = container.find(`.ai-wbr-memory-node[data-memory-node-id="${escapeCssSelector(memoryGraphDrag.nodeId)}"]`);
        group.attr('transform', `translate(${node.x},${node.y})`);
        graph.links.forEach((link) => {
            if (link.source !== node.id && link.target !== node.id) {
                return;
            }
            const line = container.find(`.ai-wbr-memory-edge[data-source-id="${escapeCssSelector(link.source)}"][data-target-id="${escapeCssSelector(link.target)}"]`);
            const source = graph.nodes.find(item => item.id === link.source);
            const target = graph.nodes.find(item => item.id === link.target);
            if (source && target) {
                line.attr({
                    x1: source.x,
                    y1: source.y,
                    x2: target.x,
                    y2: target.y,
                });
            }
        });
    });

    $(document).on('mouseup.memoryGraphSvg', (event) => {
        if (memoryGraphPan) {
            memoryGraphPan = null;
            $(svg).removeClass('ai-wbr-memory-panning');
            return;
        }

        if (!memoryGraphDrag) {
            return;
        }
        const drag = memoryGraphDrag;
        memoryGraphDrag = null;
        const graph = getMemoryGraph();
        graph.updatedAt = new Date().toISOString();
        settings.memoryGraph = graph;
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();

        if (!drag.moved) {
            showMemoryNodePopover(drag.nodeId, event.clientX, event.clientY);
        } else {
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
        }
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-popover-save', function () {
        const graph = getMemoryGraph();
        const popover = $('#ai_wbr_memory_node_popover');
        const node = graph.nodes.find(item => item.id === String(popover.data('memoryNodeId')));
        if (!node) {
            return;
        }
        popover.find('[data-popover-node-field]').each(function () {
            const field = String($(this).data('popoverNodeField'));
            node[field] = String($(this).val() || '');
        });
        node.updatedAt = new Date().toISOString();
        saveMemoryGraph(graph);
        popover.hide();
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-set-link-source', function () {
        const nodeId = String($('#ai_wbr_memory_node_popover').data('memoryNodeId'));
        memoryGraphLinkSourceId = nodeId;
        renderMemoryGraphSvg(getMemoryGraph());
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-link-to-source', function () {
        const graph = getMemoryGraph();
        const targetId = String($('#ai_wbr_memory_node_popover').data('memoryNodeId'));
        if (!memoryGraphLinkSourceId || memoryGraphLinkSourceId === targetId) {
            return;
        }
        const link = normalizeMemoryLink({
            source: memoryGraphLinkSourceId,
            target: targetId,
            type: 'RELATED',
            weight: 0.7,
            description: '手动创建的记忆关系',
        }, new Set(graph.nodes.map(node => node.id)), graph.links.length);
        if (link && !graph.links.some(item => item.source === link.source && item.target === link.target && item.type === link.type)) {
            graph.links.push(link);
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
        }
        memoryGraphLinkSourceId = '';
        $('#ai_wbr_memory_node_popover').hide();
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-popover-delete', function () {
        const graph = getMemoryGraph();
        const nodeId = String($('#ai_wbr_memory_node_popover').data('memoryNodeId'));
        graph.nodes = graph.nodes.filter(node => node.id !== nodeId);
        graph.links = graph.links.filter(link => link.source !== nodeId && link.target !== nodeId);
        saveMemoryGraph(graph);
        $('#ai_wbr_memory_node_popover').hide();
    });

    container.on('click.memoryGraphSvg', function (event) {
        if ($(event.target).closest('.ai-wbr-memory-node, .ai-wbr-memory-graph-toolbar').length) {
            return;
        }
        $('#ai_wbr_memory_node_popover').hide();
    });
}

function renderMemoryPanel() {
    if (!$('#ai_wbr_memory_graph').length) {
        return;
    }

    const graph = getMemoryGraph();
    $('#ai_wbr_memory_status').text(settings.memoryStatus || (settings.memoryEnabled ? '待整理' : '未启用'));
    $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
    $('#ai_wbr_memory_debug_panel').toggle(!!settings.memoryDebug);
    $('#ai_wbr_memory_prompt').text(settings.memoryLastPrompt || '尚无后置记忆 Prompt');
    $('#ai_wbr_memory_raw').text(settings.memoryLastRaw || '尚无后置记忆返回');
    $('#ai_wbr_memory_error').text(settings.memoryLastError || '尚无错误');
    renderMemoryGraphSvg(graph);

    const state = graph.state || {};
    $('#ai_wbr_memory_state_editor').empty().append(
        $('<div class="ai-wbr-memory-subtitle"><b>当前状态</b></div>'),
        $('<div class="ai-wbr-grid ai-wbr-memory-state-grid"></div>')
            .append($('<label></label>').text('当前地点'))
            .append($('<input class="text_pole" type="text" data-memory-state-field="current_location" />').val(state.current_location || ''))
            .append($('<label></label>').text('当前目标'))
            .append($('<input class="text_pole" type="text" data-memory-state-field="current_objective" />').val(state.current_objective || ''))
            .append($('<label></label>').text('活跃主题'))
            .append($('<input class="text_pole" type="text" data-memory-state-field="active_topics" />').val((state.active_topics || []).join('，')))
            .append($('<label></label>').text('未解问题'))
            .append($('<input class="text_pole" type="text" data-memory-state-field="open_questions" />').val((state.open_questions || []).join('，'))),
    );

    const nodesContainer = $('#ai_wbr_memory_nodes').empty();
    nodesContainer.append($('<div class="ai-wbr-memory-subtitle"><b>记忆节点</b></div>'));
    if (!graph.nodes.length) {
        nodesContainer.append('<div class="ai-wbr-token-empty">暂无节点</div>');
    }
    for (const node of graph.nodes) {
        nodesContainer.append(
            $('<div class="ai-wbr-memory-card"></div>')
                .attr('data-memory-node-id', node.id)
                .append($('<div class="ai-wbr-memory-card-head"></div>')
                    .append($('<input class="text_pole" type="text" data-memory-node-field="title" />').val(node.title || ''))
                    .append($('<input class="text_pole ai-wbr-memory-type" type="text" data-memory-node-field="type" />').val(node.type || 'event'))
                    .append($('<button class="menu_button ai-wbr-memory-delete-node" type="button">删除</button>')))
                .append($('<textarea class="text_pole ai-wbr-memory-content" rows="2" data-memory-node-field="content"></textarea>').val(node.content || ''))
                .append($('<input class="text_pole" type="text" data-memory-node-field="tags" placeholder="标签，用逗号分隔" />').val((node.tags || []).join('，'))),
        );
    }

    const linksContainer = $('#ai_wbr_memory_links').empty();
    linksContainer.append($('<div class="ai-wbr-memory-subtitle"><b>关系边</b></div>'));
    if (!graph.links.length) {
        linksContainer.append('<div class="ai-wbr-token-empty">暂无关系</div>');
    }
    for (const link of graph.links) {
        const source = graph.nodes.find(node => node.id === link.source)?.title || link.source;
        const target = graph.nodes.find(node => node.id === link.target)?.title || link.target;
        linksContainer.append(
            $('<div class="ai-wbr-memory-link-card"></div>')
                .attr('data-memory-link-id', link.id)
                .append($('<div class="ai-wbr-memory-link-title"></div>').text(`${source} → ${target}`))
                .append($('<div class="ai-wbr-memory-link-grid"></div>')
                    .append($('<input class="text_pole" type="text" data-memory-link-field="type" />').val(link.type || 'RELATED'))
                    .append($('<input class="text_pole" type="number" min="0" max="1" step="0.05" data-memory-link-field="weight" />').val(link.weight ?? 0.7))
                    .append($('<button class="menu_button ai-wbr-memory-delete-link" type="button">删除</button>')))
                .append($('<input class="text_pole" type="text" data-memory-link-field="description" placeholder="关系描述" />').val(link.description || '')),
        );
    }
}

function bindMemoryPanelActions() {
    bindCheckbox('#ai_wbr_memory_enabled', 'memoryEnabled');
    bindCheckbox('#ai_wbr_memory_auto_run', 'memoryAutoRun');
    bindCheckbox('#ai_wbr_memory_inject_to_router', 'memoryInjectToRouter');
    bindCheckbox('#ai_wbr_memory_debug', 'memoryDebug');
    bindNumber('#ai_wbr_memory_scan_messages', 'memoryScanMessages', 2, 40);
    bindNumber('#ai_wbr_memory_max_nodes', 'memoryMaxNodes', 5, 200);
    bindNumber('#ai_wbr_memory_max_links', 'memoryMaxLinks', 0, 400);

    $('#ai_wbr_memory_run_now').on('click', async (event) => {
        event.preventDefault();
        await runMemoryGraphUpdate('manual');
    });

    $('#ai_wbr_memory_save_json').on('click', (event) => {
        event.preventDefault();
        try {
            const parsed = JSON.parse(String($('#ai_wbr_memory_json').val() || '{}'));
            settings.memoryGraph = {
                ...getDefaultMemoryGraph(),
                ...parsed,
            };
            saveMemoryGraph(getMemoryGraph());
            toastr.success('记忆 JSON 已保存', '世界书读取');
        } catch (error) {
            toastr.error(`JSON 解析失败：${error.message || error}`, '世界书读取');
        }
    });

    $('#ai_wbr_memory_clear').on('click', (event) => {
        event.preventDefault();
        if (!confirm('确定清空当前轻量记忆图谱？')) {
            return;
        }
        settings.memoryGraph = getDefaultMemoryGraph();
        settings.memoryLastTurnSignature = '';
        saveMemoryGraph(settings.memoryGraph);
        setMemoryStatus('已清空');
    });

    $('#ai_worldbook_router_settings')
        .on('click', '#ai_wbr_memory_node_popover, #ai_wbr_memory_node_popover *', function (event) {
            event.stopPropagation();
        })
        .on('input change', '[data-memory-state-field]', function () {
            const graph = getMemoryGraph();
            const field = String($(this).data('memoryStateField'));
            const value = String($(this).val() || '').trim();
            if (field === 'active_topics' || field === 'open_questions') {
                graph.state[field] = uniqueStrings(value.split(/[,\n，、]+/u)).slice(0, 12);
            } else {
                graph.state[field] = value;
            }
            graph.updatedAt = new Date().toISOString();
            settings.memoryGraph = graph;
            Object.assign(extension_settings[MODULE_NAME], settings);
            saveSettingsDebounced();
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
            renderMemoryGraphSvg(graph);
        })
        .on('input change', '[data-memory-node-field]', function () {
            const graph = getMemoryGraph();
            const card = $(this).closest('[data-memory-node-id]');
            const node = graph.nodes.find(item => item.id === String(card.data('memoryNodeId')));
            if (!node) {
                return;
            }
            const field = String($(this).data('memoryNodeField'));
            const value = String($(this).val() || '');
            if (field === 'tags') {
                node.tags = uniqueStrings(value.split(/[,\n，、]+/u));
            } else if (field === 'title' || field === 'type' || field === 'content') {
                node[field] = value;
            }
            node.updatedAt = new Date().toISOString();
            graph.updatedAt = node.updatedAt;
            settings.memoryGraph = graph;
            Object.assign(extension_settings[MODULE_NAME], settings);
            saveSettingsDebounced();
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
            renderMemoryGraphSvg(graph);
        })
        .on('input change', '[data-memory-link-field]', function () {
            const graph = getMemoryGraph();
            const card = $(this).closest('[data-memory-link-id]');
            const link = graph.links.find(item => String(item.id) === String(card.data('memoryLinkId')));
            if (!link) {
                return;
            }
            const field = String($(this).data('memoryLinkField'));
            if (field === 'weight') {
                link.weight = clampNumber($(this).val(), link.weight || 0.7, 0, 1);
            } else {
                link[field] = String($(this).val() || '');
            }
            link.updatedAt = new Date().toISOString();
            graph.updatedAt = link.updatedAt;
            settings.memoryGraph = graph;
            Object.assign(extension_settings[MODULE_NAME], settings);
            saveSettingsDebounced();
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
            renderMemoryGraphSvg(graph);
        })
        .on('click', '.ai-wbr-memory-delete-node', function () {
            const graph = getMemoryGraph();
            const id = String($(this).closest('[data-memory-node-id]').data('memoryNodeId'));
            graph.nodes = graph.nodes.filter(node => node.id !== id);
            graph.links = graph.links.filter(link => link.source !== id && link.target !== id);
            saveMemoryGraph(graph);
        })
        .on('click', '.ai-wbr-memory-delete-link', function () {
            const graph = getMemoryGraph();
            const id = String($(this).closest('[data-memory-link-id]').data('memoryLinkId'));
            graph.links = graph.links.filter(link => String(link.id) !== id);
            saveMemoryGraph(graph);
        });
}

function debugLog(...args) {
    if (settings.debug) {
        console.debug(LOG_PREFIX, ...args);
    }
}

function debugRun(candidates, selected, injection, source, routerPrompt = '', routerRaw = '') {
    lastRun = {
        candidates,
        selected,
        injectedChars: injection.length,
        injectionText: injection,
        source,
        error: '',
        routerPrompt,
        routerRaw,
    };

    if (settings.debug) {
        console.groupCollapsed(`${LOG_PREFIX} routed ${selected.length}/${candidates.length}`);
        console.debug('Candidates:', candidates.map(entry => ({
            id: entry.routerId,
            world: entry.world,
            comment: entry.comment,
            keys: entry.keys.all,
            matchedKeys: entry.matchedKeys,
            score: entry.score,
            constant: entry.constant,
        })));
        console.debug('Selected:', selected.map(entry => ({
            id: entry.routerId,
            reason: entry.reason,
        })));
        console.debug('Injection chars:', injection.length);
        console.debug('Injection:', injection);
        console.groupEnd();
    }

    renderDebugPanel();
}

function debugError(error) {
    lastRun = {
        candidates: [],
        selected: [],
        injectedChars: 0,
        injectionText: '',
        source: 'error',
        error: error?.message || String(error),
        routerPrompt: '',
        routerRaw: '',
    };
    renderDebugPanel();
}

async function routeWorldbookForMessages(context, recentMessages, routeSource = 'generate_interceptor', logMeta = {}) {
    const lastUserMessage = getLastUserMessage(recentMessages);
    debugLog('Generation intercepted', { ...logMeta, routeSource, lastUserMessage });

    const mvuSummary = getCombinedStateSummary(context);
    const entries = await getWorldbookEntries(context);
    const candidates = recallCandidates(entries, recentMessages, mvuSummary);

    if (candidates.length === 0) {
        debugRun([], [], '', `none-${routeSource}`);
        lastRouteCompletedAt = Date.now();
        return {
            candidates,
            selected: [],
            injection: '',
            source: `none-${routeSource}`,
        };
    }

    let selected = [];
    let routerPrompt = '';
    let routerRaw = '';
    let source = `ai-${routeSource}`;
    let shouldFallback = false;
    try {
        isRouterSelectionRequest = true;
        const aiResult = await selectWithAi(context, recentMessages, mvuSummary, candidates);
        selected = aiResult.selected;
        routerPrompt = aiResult.prompt;
        routerRaw = aiResult.rawPreview;
        source = selected.length ? `ai-${routeSource}` : `empty-ai-${routeSource}`;
    } catch (error) {
        source = `keyword-ai-fallback-${routeSource}`;
        shouldFallback = true;
        console.warn(`${LOG_PREFIX} AI selection failed; falling back to keyword score.`, error);
        routerPrompt = error?.routerPrompt || '';
        routerRaw = error?.routerRaw || error?.message || String(error);
    } finally {
        isRouterSelectionRequest = false;
    }

    if (shouldFallback && !selected.length) {
        selected = selectWithFallback(candidates);
    }

    const injection = buildInjection(selected);
    setExtensionPrompt(PROMPT_KEY, injection, settings.position, settings.depth, false, settings.role);
    debugRun(candidates, selected, injection, source, routerPrompt, routerRaw);
    lastRouteCompletedAt = Date.now();

    return {
        candidates,
        selected,
        injection,
        source,
    };
}

async function runTavernHelperRoute(args) {
    const options = args?.[0];
    if (!shouldRouteTavernHelperGenerate(options)) {
        return false;
    }

    options._ai_wbr_routed = true;
    isCompatRouterRunning = true;
    const endRouterBusy = beginRouterBusy();
    setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
    clearEntryBurst();
    startWorldInfoAnimation();

    try {
        const context = getContext();
        const recentMessages = buildCompatRecentMessages(context, options);
        const result = await routeWorldbookForMessages(context, recentMessages, 'tavernhelper_generate', {
            type: 'tavernhelper',
        });

        stopWorldInfoAnimation();
        if (result.selected.length && !result.source.includes('fallback')) {
            playSelectedEntriesBurst(result.selected);
        }

        return true;
    } catch (error) {
        setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
        debugError(error);
        console.error(`${LOG_PREFIX} TavernHelper route failed`, error);
        return false;
    } finally {
        stopWorldInfoAnimation();
        endRouterBusy();
        isCompatRouterRunning = false;
    }
}

function renderRouterModelOptions() {
    const select = $('#ai_wbr_router_model');
    if (!select.length) {
        return;
    }

    select.empty();
    select.append('<option value="">未选择</option>');
    for (const modelId of settings.routerModels || []) {
        select.append($('<option></option>', {
            value: modelId,
            text: modelId,
            selected: modelId === settings.routerModel,
        }));
    }

    if (settings.routerModel && !settings.routerModels.includes(settings.routerModel)) {
        select.append($('<option></option>', {
            value: settings.routerModel,
            text: `${settings.routerModel} (手动)`,
            selected: true,
        }));
    }
}

async function fetchRouterModels() {
    const context = getContext();
    const apiUrl = normalizeUrl(settings.routerApiUrl);
    const apiKey = String(settings.routerApiKey || '').trim();

    if (!apiUrl) {
        toastr.warning('请先填写独立路由模型的 API URL。', '世界书读取');
        return;
    }

    if (!apiKey) {
        toastr.warning('请先填写独立路由模型的 API Key。', '世界书读取');
        return;
    }

    setRouterStatus('正在拉取模型...');

    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify({
                chat_completion_source: 'openai',
                reverse_proxy: apiUrl,
                proxy_password: apiKey,
            }),
        });

        const data = await response.json();
        const models = Array.isArray(data?.data)
            ? data.data.map(model => String(model?.id || '')).filter(Boolean)
            : [];

        if (!response.ok || !models.length) {
            throw new Error(data?.error?.message || data?.message || '没有拿到可用模型');
        }

        settings.routerModels = models;
        if (!models.includes(settings.routerModel)) {
            settings.routerModel = models[0];
        }

        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        renderRouterModelOptions();
        setRouterStatus(`已拉取 ${models.length} 个模型`);
        toastr.success(`已拉取 ${models.length} 个模型`, '世界书读取');
    } catch (error) {
        setRouterStatus(`拉取失败：${error.message || error}`);
        console.error(`${LOG_PREFIX} Failed to fetch router models`, error);
        toastr.error(String(error.message || error), '世界书读取');
    }
}

async function interceptGeneration(chat, contextSize, abort, type) {
    setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);

    if (!settings.enabled || type === 'quiet') {
        return;
    }

    const context = getContext();
    const endRouterBusy = beginRouterBusy();
    clearEntryBurst();
    startWorldInfoAnimation();
    try {
        const recentMessages = getRecentMessages(chat);
        const result = await routeWorldbookForMessages(context, recentMessages, 'generate_interceptor', {
            type,
            contextSize,
        });
        stopWorldInfoAnimation();
        if (result.selected.length && !result.source.includes('fallback')) {
            playSelectedEntriesBurst(result.selected);
        }
    } catch (error) {
        setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
        debugError(error);
        console.error(`${LOG_PREFIX} Interceptor failed`, error);
    } finally {
        stopWorldInfoAnimation();
        endRouterBusy();
    }
}

function bindCheckbox(id, key) {
    $(id).prop('checked', !!settings[key]).on('input', function () {
        saveSetting(key, !!$(this).prop('checked'));
    });
}

function bindNumber(id, key, min, max) {
    $(id).val(settings[key]).on('input', function () {
        const value = clampNumber($(this).val(), defaultSettings[key], min, max);
        saveSetting(key, value);
        $(this).val(value);
    });
}

function bindSelectNumber(id, key) {
    $(id).val(String(settings[key])).on('change', function () {
        saveSetting(key, Number($(this).val()));
    });
}

function bindTextarea(id, key) {
    $(id).val(settings[key]).on('input', function () {
        saveSetting(key, String($(this).val()));
    });
}

function bindText(id, key, normalizer = (value) => String(value)) {
    $(id).val(settings[key]).on('input', function () {
        saveSetting(key, normalizer($(this).val()));
    });
}

function renderTitleBlocklistEditor() {
    const container = $('#ai_wbr_title_block_items');
    if (!container.length) {
        return;
    }

    const rules = parseBlockRules(settings.titleBlocklist);
    container.empty();

    if (!rules.length) {
        container.append('<div class="ai-wbr-token-empty">暂无拦截标题</div>');
        return;
    }

    for (const rule of rules) {
        const item = $('<div class="ai-wbr-token-item"></div>');
        item.append($('<span class="ai-wbr-token-label"></span>').text(rule));
        item.append($('<button class="ai-wbr-token-remove" type="button" aria-label="删除">×</button>')
            .on('click', () => {
                const nextRules = parseBlockRules(settings.titleBlocklist).filter(entry => entry !== rule);
                saveSetting('titleBlocklist', nextRules.join('\n'));
                renderTitleBlocklistEditor();
            }));
        container.append(item);
    }
}

function bindTitleBlocklistEditor() {
    const input = $('#ai_wbr_title_block_input');
    const button = $('#ai_wbr_title_block_add');
    if (!input.length || !button.length) {
        return;
    }

    const submit = () => {
        const value = String(input.val() || '').trim();
        if (!value) {
            return;
        }

        const rules = parseBlockRules(settings.titleBlocklist);
        if (!rules.includes(value)) {
            rules.push(value);
            saveSetting('titleBlocklist', rules.join('\n'));
        }

        input.val('');
        renderTitleBlocklistEditor();
    };

    button.on('click', submit);
    input.on('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submit();
        }
    });

    renderTitleBlocklistEditor();
}

async function addSettingsUi() {
    const html = await renderExtensionTemplateAsync('third-party/ai-worldbook-router', 'settings');
    $('#extensions_settings2').append(html);

    bindCheckbox('#ai_wbr_enabled', 'enabled');
    bindCheckbox('#ai_wbr_debug', 'debug');
    bindCheckbox('#ai_wbr_router_use_separate_model', 'routerUseSeparateModel');
    bindCheckbox('#ai_wbr_keyword_recall', 'keywordRecall');
    bindCheckbox('#ai_wbr_use_mvu', 'useMvu');
    bindCheckbox('#ai_wbr_allow_constant', 'allowConstant');

    bindNumber('#ai_wbr_max_candidates', 'maxCandidates', 1, 100);
    bindNumber('#ai_wbr_max_selected', 'maxSelected', 1, 50);
    bindNumber('#ai_wbr_max_chars', 'maxChars', 100, 30000);
    bindNumber('#ai_wbr_scan_messages', 'scanMessages', 1, 50);
    bindNumber('#ai_wbr_main_history_ai_turns', 'mainHistoryAiTurns', 0, 100);
    bindNumber('#ai_wbr_depth', 'depth', 0, 1000);
    bindNumber('#ai_wbr_ai_response_length', 'aiResponseLength', 32, 16384);
    bindNumber('#ai_wbr_router_retries', 'routerRetries', 0, 5);

    bindSelectNumber('#ai_wbr_position', 'position');
    bindSelectNumber('#ai_wbr_role', 'role');
    bindTitleBlocklistEditor();
    bindTextarea('#ai_wbr_system_prompt', 'systemPrompt');
    bindText('#ai_wbr_router_api_url', 'routerApiUrl', normalizeUrl);
    bindText('#ai_wbr_router_api_key', 'routerApiKey', (value) => String(value).trim());
    bindMemoryPanelActions();

    renderRouterModelOptions();
    $('#ai_wbr_router_model').val(settings.routerModel).on('change', function () {
        saveSetting('routerModel', String($(this).val() || ''));
    });
    $('#ai_wbr_fetch_models').on('click', async (event) => {
        event.preventDefault();
        await fetchRouterModels();
    });
    $('#ai_wbr_router_status').text(settings.routerStatus || '未连接');

    renderDebugPanel();
    renderMemoryPanel();
}

globalThis.ai_worldbook_router_intercept = interceptGeneration;
installFetchFallbackHook();

jQuery(async () => {
    try {
        ensureSettings();
        await addSettingsUi();
        installFetchFallbackHook();
        installCompatSendHooks();
        ensureTavernHelperCompatHook();
        startCompatGenerateHookPolling();

        eventSource.on(event_types.GENERATION_STARTED, () => {
            isGenerationActive = true;
        });
        eventSource.on(event_types.GENERATION_ENDED, () => {
            isGenerationActive = false;
            scheduleCompatFlush();
            scheduleMemoryGraphUpdate();
        });
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            isGenerationActive = false;
            scheduleCompatFlush();
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            clearEntryBurst();
            stopWorldInfoAnimation();
            $('#ai_wbr_memory_node_popover').hide();
            clearTimeout(memoryUpdateTimer);
            pendingCompatSend = false;
            suppressCompatReplay = false;
            lastRun = {
                candidates: [],
                selected: [],
                injectedChars: 0,
                injectionText: '',
                source: 'none',
                error: '',
                routerPrompt: '',
                routerRaw: '',
            };
            setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
            renderDebugPanel();
            renderMemoryPanel();
        });

        debugLog('Loaded');
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed during initialization`, error);
    }
});
