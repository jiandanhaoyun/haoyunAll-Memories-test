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
import {
    clampNumber,
    countTermHits,
    matchesBlockRule,
    normalizeText,
    normalizeUrl,
    parseBlockRules,
    splitIntoSentences,
    truncateText,
    uniqueStrings,
} from './core/text-utils.js';

const MODULE_NAME = 'ai_worldbook_router';
const PROMPT_KEY = 'ai_worldbook_router_prompt';
const LOG_PREFIX = '[AI Worldbook Router]';
const MAX_MVU_CHARS = 1600;
const MAX_RECALL_TERMS = 32;
const MAX_ROUTER_CONTEXT_PREVIEW = 360;
const MAX_BURST_ITEMS = 5;
const MAX_MEMORY_CONTEXT_PREVIEW = 260;
const MAX_MEMORY_SELECTED = 4;
const CHAT_MEMORY_FIELD = 'AIWBR_ChatMemory';
const MEMORY_GRAPH_CANVAS_WIDTH = 760;
const MEMORY_GRAPH_CANVAS_HEIGHT = 340;
const MEMORY_GRAPH_NODE_WIDTH = 172;
const MEMORY_GRAPH_NODE_HEIGHT = 82;
const MEMORY_GRAPH_SAFE_PADDING = 12;
const MEMORY_GRAPH_TOP_SAFE_PADDING = 56;
const MEMORY_GRAPH_LAYOUT_PADDING = 96;
const MEMORY_GRAPH_TOUCH_TAP_THRESHOLD = 8;
const MEMORY_GRAPH_LONG_PRESS_MS = 520;
const MEMORY_NODE_TYPE_OPTIONS = [
    { value: 'event', label: '\u4e8b\u4ef6' },
    { value: 'character', label: '\u89d2\u8272' },
    { value: 'location', label: '\u5730\u70b9' },
    { value: 'faction', label: '\u52bf\u529b' },
    { value: 'item', label: '\u9053\u5177' },
    { value: 'concept', label: '\u6982\u5ff5' },
    { value: 'rule', label: '\u89c4\u5219' },
    { value: 'quest', label: '\u4efb\u52a1' },
];
const MEMORY_LINK_TYPE_OPTIONS = [
    { value: 'INVOLVES', label: '\u6d89\u53ca' },
    { value: 'PART_OF', label: '\u5c5e\u4e8e' },
    { value: 'HAPPENS_AT', label: '\u53d1\u751f\u4e8e' },
    { value: 'FOLLOWS', label: '\u540e\u7eed\u4e8e' },
    { value: 'UPDATES', label: '\u66f4\u65b0' },
    { value: 'OPPOSES', label: '\u5bf9\u7acb' },
    { value: 'ALLIED_WITH', label: '\u540c\u76df' },
    { value: 'CAUSES', label: '\u5bfc\u81f4' },
    { value: 'RELATED', label: '\u76f8\u5173' },
    { value: 'MENTIONS', label: '\u63d0\u53ca' },
];
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
    '\u5982\u679c', '\u6709\u4eba', '\u8fd9\u4e2a', '\u90a3\u4e2a', '\u8fd9\u91cc', '\u90a3\u91cc', '\u4ec0\u4e48', '\u600e\u4e48', '\u4e3a\u4f55', '\u4e3a\u4ec0\u4e48', '\u7136\u540e',
    '\u53ef\u4ee5', '\u662f\u4e0d\u662f', '\u5c31\u662f', '\u4e0d\u662f', '\u4e00\u4e2a', '\u4e00\u4e0b\u5b50', '\u8fd9\u6837', '\u90a3\u6837', '\u4f1a\u88ab', '\u4f1a\u4e0d\u4f1a',
    '\u5230\u5e95', '\u771f\u7684', '\u5df2\u7ecf', '\u73b0\u5728', '\u4e4b\u524d', '\u4e4b\u540e', '\u800c\u4e14', '\u56e0\u4e3a', '\u6240\u4ee5', '\u90a3\u4e2a\u5730\u65b9',
]);

const defaultSystemPrompt = `\u4f60\u662f SillyTavern \u7684\u524d\u7f6e\u4e16\u754c\u4e66\u8def\u7531\u5668\u3002
\u53ea\u505a\u4e00\u4ef6\u4e8b\uff1a\u4ece\u5019\u9009 keys \u4e2d\u9009\u62e9\u672c\u8f6e\u771f\u6b63\u76f8\u5173\u7684\u6761\u76ee\u3002
\u53ea\u8f93\u51fa\u4e25\u683c JSON\u3002
\u7981\u6b62 Markdown\u3002
\u7981\u6b62\u89e3\u91ca\u3002
\u7981\u6b62 reasoning\u3002
\u7981\u6b62\u989d\u5916\u5b57\u6bb5\u3002
\u552f\u4e00\u5408\u6cd5\u683c\u5f0f\uff1a{"selected":[{"key":"\u547d\u4e2d\u7684 key","reason":"\u7b80\u77ed\u539f\u56e0"}]}`;
const defaultSettings = {
    enabled: false,
    debug: false,
    entryDiagnostics: false,
    floatingButtonEnabled: true,
    routerUseSeparateModel: false,
    routerApiUrl: '',
    routerApiKey: '',
    routerModel: '',
    routerModels: [],
    routerStatus: '???',
    routerRequestMaxTokens: 10000,
    maxCandidates: 24,
    maxSelected: 5,
    maxChars: 4000,
    scanMessages: 8,
    mainHistoryAiTurns: 0,
    memoryEnabled: false,
    memoryAutoRun: true,
    memoryAutoRunInterval: 20,
    memoryRealtimeEnabled: true,
    memoryRealtimeScanMessages: 4,
    memorySummaryEnabled: true,
    memorySummaryIntervalMessages: 20,
    memorySummaryScanMessages: 24,
    memoryInjectToRouter: true,
    memoryReviewRequired: false,
    memoryDebug: false,
    memoryScopeDebug: false,
    memoryHistorySkipDone: true,
    memoryHistoryMode: 'history',
    memoryScanMessages: 6,
    memoryRequestMaxTokens: 10000,
    memoryRetries: 3,
    memoryMaxNodes: 60,
    memoryMaxLinks: 120,
    memoryContainersByChat: {},
    memoryLegacyGraphChatKeys: {},
    memoryGraphsByChat: {},
    memoryStatusesByChat: {},
    memoryLastTurnSignaturesByChat: {},
    memoryLastSourceByChat: {},
    memoryInvalidatedSourcesByChat: {},
    memoryLastPromptsByChat: {},
    memoryLastRawByChat: {},
    memoryLastErrorsByChat: {},
    memoryGraph: null,
    memoryLastTurnSignature: '',
    memoryStatus: '???',
    memoryLastPrompt: '',
    memoryLastRaw: '',
    memoryLastError: '',
    bookshelfEnabled: false,
    bookshelfAutoInject: false,
    bookshelfAutoMemoryBook: true,
    bookshelfOnlyBound: true,
    bookshelfAllowGlobal: false,
    bookshelfMaxChunks: 3,
    bookshelfMaxChunkChars: 500,
    bookshelfMinScore: 0.35,
    bookshelfMemoryVectorRecall: true,
    bookshelfMemoryVectorMaxItems: 4,
    bookshelfEmbeddingMode: 'api',
    bookshelfApiUrl: '',
    bookshelfApiKey: '',
    bookshelfApiModel: '',
    bookshelfApiModels: [],
    bookshelfApiBatchSize: 8,
    bookshelfLocalModelId: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    bookshelfLocalModelStatus: 'not_loaded',
    bookshelfLocalBatchSize: 2,
    bookshelfLastTestQuery: '',
    keywordRecall: true,
    useMvu: false,
    allowConstant: false,
    titleBlocklist: '',
    worldSelectionStates: {},
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
    memoryCandidates: [],
    selectedMemories: [],
    bookshelfCandidates: [],
    selectedBookshelf: [],
    injectedChars: 0,
    injectionText: '',
    source: 'none',
    error: '',
    routerPrompt: '',
    routerRaw: '',
    pipeline: null,
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
let memoryWorkerStartedAt = 0;
let memoryUpdateTimer = null;
let chatUiRefreshTimers = [];
let chatScopedUiPollTimer = null;
let lastObservedChatScopedUiSignature = '';
let memoryGraphView = { x: 0, y: 0, width: MEMORY_GRAPH_CANVAS_WIDTH, height: MEMORY_GRAPH_CANVAS_HEIGHT };
let memoryGraphDrag = null;
let memoryGraphPan = null;
let memoryGraphTouch = null;
let memoryGraphLinkSourceId = '';
let memoryGraphSelectedNodeId = '';
let memoryGraphSelectedLinkId = '';
let memoryGraphDetailMode = '';
let memoryGraphDisplayMode = 'overview';
let memoryGraphMinLinkWeight = 0.35;
let memoryGraphSearchText = '';
let memoryGraphVisibleTypes = new Set();
let memoryGraphSearchTimer = null;
let memoryGraphRenderFrame = null;
let memoryGraphPreviewRenderKey = '';
let memoryGraphDragFrame = null;
let memoryGraphFullscreenActive = false;
let memoryGraphSuppressNextNodeClick = false;
let bookshelfDbPromise = null;
let selectedBookshelfBookId = '';
let bookshelfLastTestResults = [];
let bookshelfLastStatus = '';
let bookshelfLocalPipelinePromise = null;
let bookshelfVectorAbortRequested = false;
let bookshelfMemoryBookSyncTimer = null;
const BOOKSHELF_DB_NAME = 'AIWBR_VectorBookshelf';
const BOOKSHELF_DB_VERSION = 2;
const BOOKSHELF_MAX_IMPORT_CHUNKS = 2000;
const BOOKSHELF_LOCAL_TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
let lastKnownChatFileName = '';

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

function clearChatUiRefreshTimers() {
    for (const timer of chatUiRefreshTimers) {
        clearTimeout(timer);
    }
    chatUiRefreshTimers = [];
}

function getChatScopedUiSignature(context = getContext()) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const first = chat[0];
    const memoryRaw = first && typeof first === 'object' ? first[CHAT_MEMORY_FIELD] : '';
    const memoryStamp = typeof memoryRaw === 'string'
        ? memoryRaw.slice(0, 120)
        : JSON.stringify(memoryRaw || {}).slice(0, 120);
    const charaFile = String(getCharaFilename?.() || '');
    const character = context?.characters?.[context?.characterId] || context?.character;
    const worldStamp = getActiveWorldbookBindings(context)
        .map(binding => `${binding.worldName}:${binding.source}:${getWorldSelectionState(binding.worldName) ? '1' : '0'}`)
        .join(',');
    return [
        charaFile,
        String(context?.characterId ?? context?.character_id ?? ''),
        String(context?.groupId ?? context?.group_id ?? ''),
        String(character?.avatar ?? character?.name ?? ''),
        String(context?.chatId ?? context?.chat_id ?? context?.conversationId ?? context?.sessionId ?? ''),
        String(context?.chatMetadata?.file_name ?? context?.chatMetadata?.main_chat ?? context?.chatMetadata?.name ?? ''),
        String(chat.length),
        memoryStamp,
        worldStamp,
    ].join('|');
}

function rememberChatIdentifierFromEvent(...args) {
    for (const arg of args) {
        const value = typeof arg === 'string'
            ? arg
            : (arg?.chatId || arg?.chat_id || arg?.file_name || arg?.filename || arg?.name || '');
        const text = String(value || '').trim();
        if (text && text !== 'null' && text !== 'undefined') {
            lastKnownChatFileName = text;
            return text;
        }
    }
    return '';
}

function getMemoryGraphSummary(graph) {
    const safeGraph = graph && typeof graph === 'object' ? graph : getDefaultMemoryGraph();
    const state = safeGraph.state || {};
    return {
        location: state.current_location || '',
        time: state.current_time || '',
        objective: state.current_objective || '',
        nodes: Array.isArray(safeGraph.nodes) ? safeGraph.nodes.length : 0,
        links: Array.isArray(safeGraph.links) ? safeGraph.links.length : 0,
        nodeTitles: (Array.isArray(safeGraph.nodes) ? safeGraph.nodes : []).slice(0, 8).map(node => `${node.type || 'memory'}:${node.title || node.id}`),
        updatedAt: safeGraph.updatedAt || '',
    };
}

function getMemoryScopeDebugSnapshot(context = getContext()) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const first = getChatMemoryFirstMessage(context);
    const raw = first && typeof first === 'object' ? first[CHAT_MEMORY_FIELD] : undefined;
    const parsed = typeof raw === 'string'
        ? (() => {
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        })()
        : raw;
    return {
        signature: getChatScopedUiSignature(context),
        chatLength: chat.length,
        firstMessageName: first?.name || '',
        hasFirstMessage: !!first,
        hasChatMemoryField: raw !== undefined,
        rawType: raw === undefined ? 'undefined' : typeof raw,
        rawPreview: typeof raw === 'string' ? raw.slice(0, 180) : JSON.stringify(raw || null).slice(0, 180),
        parsedGraph: getMemoryGraphSummary(parsed?.graph || null),
        contextIds: {
            charaFile: String(getCharaFilename?.() || ''),
            characterId: context?.characterId ?? context?.character_id ?? '',
            groupId: context?.groupId ?? context?.group_id ?? '',
            chatId: context?.chatId ?? context?.chat_id ?? '',
            conversationId: context?.conversationId ?? '',
            sessionId: context?.sessionId ?? '',
            metadataFile: context?.chatMetadata?.file_name ?? context?.chatMetadata?.main_chat ?? context?.chatMetadata?.name ?? '',
        },
    };
}

function memoryScopeDebugLog(action, details = {}, context = getContext()) {
    if (!settings.memoryScopeDebug) {
        return;
    }
    try {
        console.groupCollapsed(`${LOG_PREFIX} [MemoryScope] ${action}`);
        console.debug('snapshot:', getMemoryScopeDebugSnapshot(context));
        if (details && Object.keys(details).length) {
            console.debug('details:', details);
        }
        console.groupEnd();
    } catch (error) {
        console.warn(`${LOG_PREFIX} [MemoryScope] debug log failed`, error);
    }
}

if (typeof window !== 'undefined') {
    window.aiWbrMemoryDebugDump = () => {
        const snapshot = getMemoryScopeDebugSnapshot();
        console.debug(`${LOG_PREFIX} [MemoryScope] manual dump`, snapshot);
        return snapshot;
    };
}

function clearMemoryUiForScopeSwitch() {
    memoryScopeDebugLog('clearMemoryUiForScopeSwitch');
    $('#ai_wbr_memory_node_popover').hide();
    $('#ai_wbr_memory_graph').html('<div class="ai-wbr-token-empty">正在切换聊天记忆...</div>');
    $('#ai_wbr_memory_node_editor').empty().append('<div class="ai-wbr-token-empty">点击上方图谱节点后，这里会显示该节点的可编辑信息。</div>');
    $('#ai_wbr_memory_nodes').empty();
    $('#ai_wbr_memory_links').empty();
    $('#ai_wbr_memory_json').val('');
}

function safeRenderChatScopedPanels() {
    if (memoryGraphDrag || memoryGraphPan) {
        memoryScopeDebugLog('safeRenderChatScopedPanels skipped while dragging/panning');
        return;
    }
    memoryScopeDebugLog('safeRenderChatScopedPanels before render');
    renderDebugPanel();
    renderMemoryPanel();
    renderActiveWorldbookSelector();
}

function scheduleChatScopedUiRefresh() {
    clearChatUiRefreshTimers();
    const delays = [0, 40, 140, 360, 800];
    memoryScopeDebugLog('scheduleChatScopedUiRefresh', { delays });
    for (const delay of delays) {
        const timer = setTimeout(() => {
            safeRenderChatScopedPanels();
        }, delay);
        chatUiRefreshTimers.push(timer);
    }
}

function startChatScopedUiPolling() {
    if (chatScopedUiPollTimer) {
        clearInterval(chatScopedUiPollTimer);
    }
    lastObservedChatScopedUiSignature = getChatScopedUiSignature();
    chatScopedUiPollTimer = setInterval(() => {
        if (memoryGraphDrag || memoryGraphPan) {
            return;
        }
        const nextSignature = getChatScopedUiSignature();
        if (nextSignature !== lastObservedChatScopedUiSignature) {
            memoryScopeDebugLog('poll signature changed', {
                previous: lastObservedChatScopedUiSignature,
                next: nextSignature,
            });
            lastObservedChatScopedUiSignature = nextSignature;
            safeRenderChatScopedPanels();
        }
    }, 500);
}

function handleChatScopedUiMaybeChanged() {
    memoryScopeDebugLog('handleChatScopedUiMaybeChanged');
    clearEntryBurst();
    stopWorldInfoAnimation();
    clearTimeout(memoryUpdateTimer);
    clearTimeout(bookshelfMemoryBookSyncTimer);
    clearChatUiRefreshTimers();
    memoryGraphSelectedNodeId = '';
    memoryGraphSelectedLinkId = '';
    memoryGraphLinkSourceId = '';
    selectedBookshelfBookId = '';
    clearMemoryUiForScopeSwitch();
    lastObservedChatScopedUiSignature = '';
    scheduleChatScopedUiRefresh();
    scheduleBookshelfMemoryBookSync(getContext(), { force: true, silent: true, delayMs: 250 });
}

function handleMessageDeletedOrSwiped() {
    try {
        const context = getContext();
        const chatKey = getCurrentChatMemoryKey(context);
        const lastSource = settings.memoryLastSourceByChat?.[chatKey];
        if (lastSource?.id) {
            settings.memoryInvalidatedSourcesByChat[chatKey] = uniqueStrings([
                ...(Array.isArray(settings.memoryInvalidatedSourcesByChat?.[chatKey]) ? settings.memoryInvalidatedSourcesByChat[chatKey] : []),
                String(lastSource.id),
            ]).slice(-40);
        }
        const container = getChatMemoryContainer(context);
        if (Array.isArray(container.reviewQueue) && container.reviewQueue.length) {
            container.reviewQueue = container.reviewQueue.map(item => ({
                ...item,
                status: item.status === 'pending' ? 'stale' : item.status,
                staleReason: item.staleReason || 'message_changed',
            }));
        }
        if (container.graphBackup) {
            memoryScopeDebugLog('Restoring memory graph from backup due to message deletion/swipe');
            container.graph = cloneMemoryGraph(container.graphBackup);
            container.graphBackup = null;
            persistChatMemoryContainer(container, context);
            settings.memoryGraph = container.graph;
            Object.assign(extension_settings[MODULE_NAME], settings);
            saveSettingsDebounced();
            setCurrentMemoryLastTurnSignature('', context);
            setMemoryStatus('\u5df2\u56de\u9000\u8bb0\u5fc6\u72b6\u6001\uff08\u68c0\u6d4b\u5230\u91cd\u751f\u6210/\u5220\u9664\uff09', context);
            scheduleBookshelfMemoryBookSync(context, { force: true, silent: true, delayMs: 200 });
            
            // Re-render UI if applicable
            if (!memoryGraphDrag && !memoryGraphPan) {
                scheduleChatScopedUiRefresh();
            }
        } else {
            persistChatMemoryContainer(container, context);
            setCurrentMemoryLastTurnSignature('', context);
            scheduleBookshelfMemoryBookSync(context, { force: true, silent: true, delayMs: 200 });
            scheduleChatScopedUiRefresh();
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to restore memory graph backup`, error);
    }
}

function installChatScopedUiRefreshEventHooks() {
    const strictScopeEvents = [
        'CHAT_CHANGED',
        'CHAT_LOADED',
    ];

    for (const key of strictScopeEvents) {
        const value = event_types?.[key];
        if (!value) {
            continue;
        }
        try {
            eventSource.on(value, (...args) => {
                rememberChatIdentifierFromEvent(...args);
                memoryScopeDebugLog(`event ${key}`, {
                    eventValue: value,
                    argsPreview: args.slice(0, 2).map(arg => {
                        try {
                            return JSON.stringify(arg).slice(0, 240);
                        } catch {
                            return String(arg);
                        }
                    }),
                });
                handleChatScopedUiMaybeChanged();
            });
        } catch {
            // no-op
        }
    }

    const rollbackEvents = ['MESSAGE_DELETED', 'MESSAGE_SWIPED'];
    for (const key of rollbackEvents) {
        const value = event_types?.[key];
        if (!value) {
            continue;
        }
        try {
            eventSource.on(value, () => {
                handleMessageDeletedOrSwiped();
            });
        } catch {
            // no-op
        }
    }
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
    if (!Object.hasOwn(extension_settings[MODULE_NAME], 'memoryRealtimeEnabled')) {
        settings.memoryRealtimeEnabled = !!settings.memoryAutoRun;
    }
    if (!Object.hasOwn(extension_settings[MODULE_NAME], 'memorySummaryEnabled')) {
        settings.memorySummaryEnabled = !!settings.memoryAutoRun;
    }
    if (!Object.hasOwn(extension_settings[MODULE_NAME], 'memorySummaryIntervalMessages')) {
        settings.memorySummaryIntervalMessages = clampNumber(settings.memoryAutoRunInterval, defaultSettings.memorySummaryIntervalMessages, 1, 100);
    }
    if (!Object.hasOwn(extension_settings[MODULE_NAME], 'memoryRealtimeScanMessages')) {
        settings.memoryRealtimeScanMessages = Math.min(6, clampNumber(settings.memoryScanMessages, defaultSettings.memoryRealtimeScanMessages, 2, 40));
    }
    if (!Object.hasOwn(extension_settings[MODULE_NAME], 'memorySummaryScanMessages')) {
        settings.memorySummaryScanMessages = Math.max(8, clampNumber(settings.memoryScanMessages, defaultSettings.memorySummaryScanMessages, 2, 40));
    }
    settings.memoryContainersByChat = settings.memoryContainersByChat && typeof settings.memoryContainersByChat === 'object' ? settings.memoryContainersByChat : {};
    settings.memoryLegacyGraphChatKeys = settings.memoryLegacyGraphChatKeys && typeof settings.memoryLegacyGraphChatKeys === 'object' ? settings.memoryLegacyGraphChatKeys : {};
    settings.worldSelectionStates = settings.worldSelectionStates && typeof settings.worldSelectionStates === 'object' ? settings.worldSelectionStates : {};
    settings.memoryGraphsByChat = settings.memoryGraphsByChat && typeof settings.memoryGraphsByChat === 'object' ? settings.memoryGraphsByChat : {};
    settings.memoryStatusesByChat = settings.memoryStatusesByChat && typeof settings.memoryStatusesByChat === 'object' ? settings.memoryStatusesByChat : {};
    settings.memoryLastTurnSignaturesByChat = settings.memoryLastTurnSignaturesByChat && typeof settings.memoryLastTurnSignaturesByChat === 'object' ? settings.memoryLastTurnSignaturesByChat : {};
    settings.memoryLastSourceByChat = settings.memoryLastSourceByChat && typeof settings.memoryLastSourceByChat === 'object' ? settings.memoryLastSourceByChat : {};
    settings.memoryInvalidatedSourcesByChat = settings.memoryInvalidatedSourcesByChat && typeof settings.memoryInvalidatedSourcesByChat === 'object' ? settings.memoryInvalidatedSourcesByChat : {};
    settings.memoryLastPromptsByChat = settings.memoryLastPromptsByChat && typeof settings.memoryLastPromptsByChat === 'object' ? settings.memoryLastPromptsByChat : {};
    settings.memoryLastRawByChat = settings.memoryLastRawByChat && typeof settings.memoryLastRawByChat === 'object' ? settings.memoryLastRawByChat : {};
    settings.memoryLastErrorsByChat = settings.memoryLastErrorsByChat && typeof settings.memoryLastErrorsByChat === 'object' ? settings.memoryLastErrorsByChat : {};
    if (!settings.memoryGraph || typeof settings.memoryGraph !== 'object') {
        settings.memoryGraph = getDefaultMemoryGraph();
    }
    Object.assign(extension_settings[MODULE_NAME], settings);
    try {
        globalThis.AIWorldbookRouter?.setEntryDiagnostics?.(!!settings.entryDiagnostics);
    } catch (_) {
        // Bootstrap diagnostics sync is best-effort only.
    }
}

function saveSetting(key, value) {
    settings[key] = value;
    Object.assign(extension_settings[MODULE_NAME], settings);
    if (key === 'entryDiagnostics') {
        try {
            localStorage.setItem('AIWBR_entryDiagnosticsEnabled', value ? 'true' : 'false');
            globalThis.AIWorldbookRouter?.setEntryDiagnostics?.(!!value);
        } catch (_) {
            // localStorage may be unavailable in some embedded webviews.
        }
    }
    if (key === 'floatingButtonEnabled') {
        updateFloatingButtonVisibility();
    }
    saveSettingsDebounced();
}

function setRouterStatus(text) {
    settings.routerStatus = String(text || '\u672a\u8fde\u63a5');
    $('#ai_wbr_router_status').text(settings.routerStatus);
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
    renderStandaloneConsole();
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

function startMemoryAnimation() {
    startWorldInfoAnimation();
    const underline = $('#ai_wbr_fx_layer .ai-wbr-book-underline');
    if (!underline.length) {
        return;
    }
    underline.addClass('ai-wbr-book-underline-memory');
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

async function requestMemoryExtraction(context, prompt, systemPrompt) {
    if (settings.routerUseSeparateModel && settings.routerApiUrl && settings.routerApiKey && settings.routerModel) {
        return sendSeparateMemoryRequest(context, prompt, {
            systemPrompt,
            maxTokens: getMemoryRequestMaxTokens(),
        });
    }

    return context.generateRaw({
        prompt,
        systemPrompt,
        responseLength: getMemoryRequestMaxTokens(),
        trimNames: false,
    });
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

function getMemoryBurstLabel(entry) {
    const title = String(entry?.title || '').trim();
    if (title) {
        return truncateText(title, 22);
    }
    const content = String(entry?.content || '').trim();
    if (content) {
        return truncateText(content.split(/[。.!?\n]/u)[0], 22);
    }
    return truncateText(String(entry?.id || '记忆更新'), 22);
}

function playEntryBurst(entries, {
    variant = 'router',
    labelGetter = getEntryBurstLabel,
} = {}) {
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
        const chip = $('<div class="ai-wbr-entry-burst"></div>')
            .addClass(variant === 'memory' ? 'ai-wbr-entry-burst-memory' : '')
            .text(labelGetter(entry));
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

function playSelectedEntriesBurst(entries) {
    playEntryBurst(entries, {
        variant: 'router',
        labelGetter: getEntryBurstLabel,
    });
}

function extractActualUserInput(value) {
    const text = String(value ?? '');
    const match = text.match(/<\u672c\u8f6e\u7528\u6237\u8f93\u5165>\s*([\s\S]*?)\s*<\/\u672c\u8f6e\u7528\u6237\u8f93\u5165>/i);
    return (match ? match[1] : text).trim();
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

function getBlockedTitleRule(entry) {
    const comment = String(entry?.comment || '').trim();
    if (!comment) {
        return '';
    }

    return parseBlockRules(settings.titleBlocklist).find(rule => matchesBlockRule(comment, rule)) || '';
}

function getWorldSelectionState(worldName) {
    const name = String(worldName || '').trim();
    if (!name) {
        return true;
    }
    const state = settings.worldSelectionStates?.[name];
    return state !== false;
}

function setWorldSelectionState(worldName, enabled) {
    const name = String(worldName || '').trim();
    if (!name) {
        return;
    }
    const nextStates = {
        ...(settings.worldSelectionStates || {}),
        [name]: !!enabled,
    };
    saveSetting('worldSelectionStates', nextStates);
}

function getActiveWorldbookBindings(context = getContext()) {
    const character = context.characters?.[context.characterId];
    const worldBindings = [];
    const seen = new Set();

    const addWorld = (worldName, source) => {
        const name = String(worldName || '').trim();
        if (!name || seen.has(name)) {
            return;
        }
        seen.add(name);
        worldBindings.push({
            worldName: name,
            source,
        });
    };

    for (const worldName of selected_world_info || []) {
        addWorld(worldName, '全局');
    }

    addWorld(context.chatMetadata?.[METADATA_KEY], '聊天绑定');
    addWorld(character?.data?.extensions?.world, '角色绑定');
    addWorld(context.powerUserSettings?.persona_description_lorebook, '人格绑定');

    try {
        const fileName = context.characterId !== undefined ? getCharaFilename(context.characterId) : '';
        const extraCharLore = world_info.charLore?.find(entry => entry.name === fileName);
        for (const worldName of extraCharLore?.extraBooks || []) {
            addWorld(worldName, '角色额外');
        }
    } catch (error) {
        debugLog('Could not read active worldbook bindings', error);
    }

    const embeddedBook = character?.data?.character_book;
    if (embeddedBook?.entries?.length) {
        addWorld(embeddedBook.name || character?.name || 'embedded', '角色内嵌');
    }

    return worldBindings;
}

function getEntryId(entry, fallback) {
    return entry.uid ?? entry.id ?? entry.displayIndex ?? fallback;
}

function getEntryKeys(entry = {}) {
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
            current_time: '',
            protagonist_status: '',
            current_objective: '',
            current_phase: '',
            active_topics: [],
            open_questions: [],
            custom_values: {},
        },
        stateDefinitions: [],
        nodes: [],
        links: [],
        lastSummary: '',
        updatedAt: '',
    };
}

function hashString(value) {
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function getStableChatScopeParts(context = getContext()) {
    const cleanParts = (values) => {
        const parts = [];
        for (const candidate of values) {
            const value = String(candidate ?? '').trim();
            if (value && !parts.includes(value)) {
                parts.push(value);
            }
        }
        return parts;
    };

    const charaFile = String(getCharaFilename?.() || '').trim();
    const scopeParts = cleanParts([
        context?.groupId,
        context?.group_id,
        context?.characterId,
        context?.character_id,
        context?.name2,
        context?.character?.avatar,
        context?.character?.name,
        charaFile,
    ]);

    const stableChatParts = cleanParts([
        context?.chatId,
        context?.chat_id,
        context?.conversationId,
        context?.sessionId,
        context?.chatFileName,
        context?.chat_filename,
        lastKnownChatFileName,
        context?.chatMetadata?.chat_id,
        context?.chatMetadata?.session_id,
        context?.chatMetadata?.filename,
        context?.chatMetadata?.file_name,
        context?.chatMetadata?.main_chat,
        context?.chatMetadata?.mainChat,
        context?.chatMetadata?.chat_name,
        context?.chatMetadata?.name,
        context?.chatName,
        context?.chat_name,
    ]);

    return { scopeParts, stableChatParts };
}

function getCurrentChatMemoryKey(context = getContext()) {
    const { scopeParts, stableChatParts } = getStableChatScopeParts(context);
    if (stableChatParts.length) {
        return `chat:v2:${[...scopeParts, ...stableChatParts].join('|')}`;
    }

    if (scopeParts.length) {
        return `chat:v2:scope-only:${scopeParts.join('|')}`;
    }

    return 'chat:v2:default';
}

function idbRequestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
}

function getBookshelfDb() {
    if (bookshelfDbPromise) {
        return bookshelfDbPromise;
    }
    if (!globalThis.indexedDB) {
        bookshelfDbPromise = Promise.reject(new Error('Current WebView does not support IndexedDB; vector bookshelf is unavailable.'));
        return bookshelfDbPromise;
    }

    bookshelfDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(BOOKSHELF_DB_NAME, BOOKSHELF_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('books')) {
                const books = db.createObjectStore('books', { keyPath: 'id' });
                books.createIndex('updatedAt', 'updatedAt');
            }
            if (!db.objectStoreNames.contains('chunks')) {
                const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
                chunks.createIndex('bookId', 'bookId');
                chunks.createIndex('updatedAt', 'updatedAt');
            }
            if (!db.objectStoreNames.contains('memoryVectors')) {
                const memoryVectors = db.createObjectStore('memoryVectors', { keyPath: 'id' });
                memoryVectors.createIndex('chatKey', 'chatKey');
                memoryVectors.createIndex('nodeId', 'nodeId');
                memoryVectors.createIndex('updatedAt', 'updatedAt');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    });
    return bookshelfDbPromise;
}

async function bookshelfGetAll(storeName) {
    const db = await getBookshelfDb();
    const tx = db.transaction(storeName, 'readonly');
    return await idbRequestToPromise(tx.objectStore(storeName).getAll());
}

async function bookshelfGet(storeName, key) {
    const db = await getBookshelfDb();
    const tx = db.transaction(storeName, 'readonly');
    return await idbRequestToPromise(tx.objectStore(storeName).get(key));
}

async function bookshelfPut(storeName, record) {
    const db = await getBookshelfDb();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    return await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
    });
}

async function bookshelfPutMany(storeName, records) {
    const db = await getBookshelfDb();
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const record of records) {
        store.put(record);
    }
    return await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(records);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB batch write failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB batch write aborted'));
    });
}

async function bookshelfDelete(storeName, key) {
    const db = await getBookshelfDb();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    return await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
    });
}

async function bookshelfDeleteBook(bookId) {
    const db = await getBookshelfDb();
    const tx = db.transaction(['books', 'chunks'], 'readwrite');
    tx.objectStore('books').delete(bookId);
    const chunkStore = tx.objectStore('chunks');
    const index = chunkStore.index('bookId');
    const cursorRequest = index.openCursor(IDBKeyRange.only(bookId));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
    };
    return await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB delete book failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB delete book aborted'));
    });
}

async function bookshelfDeleteMemoryVectorsForChat(chatKey) {
    const db = await getBookshelfDb();
    const tx = db.transaction('memoryVectors', 'readwrite');
    const store = tx.objectStore('memoryVectors');
    const index = store.index('chatKey');
    const cursorRequest = index.openCursor(IDBKeyRange.only(chatKey));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
    };
    return await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB delete memory vectors failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB delete memory vectors aborted'));
    });
}

function getBookshelfScope(context = getContext()) {
    const { scopeParts, stableChatParts } = getStableChatScopeParts(context);
    const characterKey = scopeParts.length ? `character:${scopeParts.join('|')}` : 'character:default';
    const chatKey = getCurrentChatMemoryKey(context);
    const characterName = String(context?.name2 || context?.character?.name || context?.characterName || '当前角色').trim();
    const chatName = String(
        context?.chatName
        || context?.chat_name
        || context?.chatMetadata?.chat_name
        || context?.chatMetadata?.name
        || stableChatParts[0]
        || '当前聊天',
    ).trim();
    return { characterKey, chatKey, characterName, chatName };
}

function normalizeBookshelfBindings(book) {
    return Array.isArray(book?.bindings)
        ? book.bindings.filter(item => item && item.type && item.key)
        : [];
}

function isBookshelfBookBound(book, type, key) {
    return normalizeBookshelfBindings(book).some(item => item.type === type && item.key === key);
}

function isBookshelfBookAvailable(book, context = getContext()) {
    if (!book || book.enabled === false) return false;
    if (String(book.status || '') !== 'ready' && Number(book.vectorizedCount || 0) <= 0) return false;
    const scope = getBookshelfScope(context);
    const bindings = normalizeBookshelfBindings(book);
    if (bindings.some(item => item.type === 'chat' && item.key === scope.chatKey)) return true;
    if (bindings.some(item => item.type === 'character' && item.key === scope.characterKey)) return true;
    if (settings.bookshelfAllowGlobal && bindings.some(item => item.type === 'global')) return true;
    return false;
}

function setBookshelfStatus(text) {
    bookshelfLastStatus = String(text || '');
    $('[id="ai_wbr_bookshelf_status"]').text(bookshelfLastStatus || 'No books imported yet. Import TXT files to enable retrieval.');
}
function setBookshelfModelStatus(text) {
    $('[id="ai_wbr_bookshelf_model_status"]').text(text || 'Model not loaded');
}

function renderBookshelfApiModelOptions() {
    const models = Array.isArray(settings.bookshelfApiModels)
        ? settings.bookshelfApiModels.map(model => String(model || '').trim()).filter(Boolean)
        : [];
    const current = String(settings.bookshelfApiModel || '').trim();
    $('[id="ai_wbr_bookshelf_api_model"]').each(function () {
        const select = $(this);
        if (!select.is('select')) return;
        select.empty().append($('<option></option>', {
            value: '',
            text: models.length ? 'Select embedding model' : 'Fetch models first',
        }));
        for (const model of models) {
            select.append($('<option></option>', {
                value: model,
                text: model,
                selected: model === current,
            }));
        }
        if (current && !models.includes(current)) {
            select.append($('<option></option>', {
                value: current,
                text: `${current}（手动）`,
                selected: true,
            }));
        }
        select.val(current);
    });
}

function syncBookshelfProviderVisibility() {
    const mode = getBookshelfEmbeddingMode();
    const toggleField = (id, visible) => {
        const rawId = id.replace(/^#/, '');
        const field = $(`[id="${rawId}"]`);
        field.toggle(visible);
        $(`label[for="${rawId}"]`).toggle(visible);
    };
    toggleField('#ai_wbr_bookshelf_api_url', mode === 'api');
    toggleField('#ai_wbr_bookshelf_api_key', mode === 'api');
    toggleField('#ai_wbr_bookshelf_api_model', mode === 'api');
    $('[id="ai_wbr_bookshelf_fetch_models"]').toggle(mode === 'api');
    toggleField('#ai_wbr_bookshelf_local_model', mode === 'browser-local');
    $('[id="ai_wbr_bookshelf_load_local"]').toggle(mode === 'browser-local');
    setBookshelfModelStatus(mode === 'browser-local'
        ? `Local model: ${settings.bookshelfLocalModelStatus || 'not_loaded'}`
        : (settings.bookshelfApiModel ? `API model: ${settings.bookshelfApiModel}` : 'API model not configured'));
}

function getBookshelfModelsApiUrl() {
    const base = normalizeUrl(settings.bookshelfApiUrl || '');
    if (!base) {
        throw new Error('Please enter the bookshelf API URL first.');
    }
    if (/\/models$/i.test(base)) return base;
    if (/\/embeddings$/i.test(base)) return base.replace(/\/embeddings$/i, '/models');
    if (/\/v1$/i.test(base)) return `${base}/models`;
    return `${base.replace(/\/$/, '')}/v1/models`;
}

async function fetchBookshelfApiModels() {
    const apiUrl = getBookshelfModelsApiUrl();
    const apiKey = String(settings.bookshelfApiKey || '').trim();
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    setBookshelfModelStatus('Fetching models...');
    const response = await fetch(apiUrl, {
        method: 'GET',
        headers,
        cache: 'no-cache',
    });
    const data = await response.json().catch(() => ({}));
    const models = Array.isArray(data?.data)
        ? data.data.map(model => String(model?.id || model?.name || '')).filter(Boolean)
        : [];

    if (!response.ok || !models.length) {
        throw new Error(data?.error?.message || data?.message || `No embedding models returned (HTTP ${response.status}).`);
    }

    settings.bookshelfApiModels = uniqueStrings(models);
    if (!settings.bookshelfApiModel || !settings.bookshelfApiModels.includes(settings.bookshelfApiModel)) {
        settings.bookshelfApiModel = settings.bookshelfApiModels[0] || '';
    }
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
    renderBookshelfApiModelOptions();
    $('#ai_wbr_bookshelf_api_model').val(settings.bookshelfApiModel || '');
    setBookshelfModelStatus(`Fetched ${settings.bookshelfApiModels.length} models`);
    toastr?.success?.('Done.', 'AI Worldbook Router');
}

function readBookshelfTextFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('TXT 读取失败'));
        reader.readAsText(file);
    });
}

function detectBookshelfChunkTitle(text, fallback = '') {
    const firstLine = String(text || '').split('\\n').map(i => i.trim()).find(Boolean) || '';
    if (/^(chapter|section|part|#{1,6}\\s+|[0-9]+[.)?\\s])/.test(firstLine.toLowerCase())) {
        return truncateText(firstLine.replace(/^#{1,6}\\s+/, ''), 60);
    }
    return truncateText(fallback || firstLine || 'Untitled chunk', 60);
}
function splitTextIntoBookshelfChunks(text, options = {}) {
    const chunkSize = clampNumber(options.chunkSize, 700, 200, 2000);
    const overlap = clampNumber(options.overlap, 100, 0, Math.floor(chunkSize / 2));
    const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!normalized) return [];

    const paragraphs = normalized
        .split(/\n{2,}/)
        .map(item => item.replace(/\n+/g, '\n').trim())
        .filter(Boolean);
    const chunks = [];
    let current = '';
    let currentTitle = '';

    const pushCurrent = () => {
        const content = current.trim();
        if (!content) return;
        chunks.push({
            title: currentTitle || detectBookshelfChunkTitle(content, `片段 ${chunks.length + 1}`),
            text: content,
        });
        current = '';
    };

    const pushLongText = (value, title) => {
        const clean = String(value || '').trim();
        if (!clean) return;
        let start = 0;
        while (start < clean.length && chunks.length < BOOKSHELF_MAX_IMPORT_CHUNKS) {
            const part = clean.slice(start, start + chunkSize).trim();
            if (part) {
                chunks.push({ title: title || `片段 ${chunks.length + 1}`, text: part });
            }
            if (start + chunkSize >= clean.length) break;
            start += Math.max(1, chunkSize - overlap);
        }
    };

    for (const paragraph of paragraphs) {
        if (chunks.length >= BOOKSHELF_MAX_IMPORT_CHUNKS) break;
        const title = detectBookshelfChunkTitle(paragraph, '');
        if (title && paragraph.length < 120) {
            pushCurrent();
            currentTitle = title;
            continue;
        }
        if (paragraph.length > chunkSize * 1.5) {
            pushCurrent();
            pushLongText(paragraph, currentTitle || title);
            continue;
        }
        if ((current + '\n\n' + paragraph).length > chunkSize) {
            pushCurrent();
        }
        current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    pushCurrent();
    return chunks.slice(0, BOOKSHELF_MAX_IMPORT_CHUNKS);
}

function getMemoryBookTypeConfig(type) {
    const normalized = String(type || 'other').toLowerCase();
    if (['character', 'person', 'npc', 'role'].includes(normalized)) {
        return { key: 'character', type: 'character', title: '自动记忆书：人物档案' };
    }
    if (['event', 'plot', 'quest', 'scene', 'timeline'].includes(normalized)) {
        return { key: 'plot', type: 'plot', title: '自动记忆书：剧情时间线' };
    }
    if (['rule', 'concept', 'world', 'faction', 'location', 'place', 'item'].includes(normalized)) {
        return { key: 'world', type: normalized === 'rule' ? 'rule' : 'world', title: '自动记忆书：世界设定' };
    }
    return { key: 'memory', type: 'memory', title: '自动记忆书：综合记忆' };
}

function formatMemoryBookNodeChunk(node, graph = getMemoryGraph()) {
    const relatedLinks = (Array.isArray(graph?.links) ? graph.links : [])
        .filter(link => String(link?.source) === String(node?.id) || String(link?.target) === String(node?.id))
        .slice(0, 6)
        .map(link => {
            const otherId = String(link.source) === String(node.id) ? link.target : link.source;
            const other = (Array.isArray(graph?.nodes) ? graph.nodes : []).find(item => String(item.id) === String(otherId));
            return `${link.type || 'RELATED'} -> ${other?.title || otherId}`;
        });
    const parts = [];
    const push = (label, value) => {
        const text = String(value || '').trim();
        if (text) parts.push(`${label}：${text}`);
    };
    push('标题', node?.title || node?.id);
    push('类型', node?.type);
    push('摘要', node?.summary);
    push('内容', node?.content);
    push('地点', node?.location);
    push('时间', node?.timeSpan);
    if (Array.isArray(node?.tags) && node.tags.length) push('标签', node.tags.join('、'));
    if (Array.isArray(node?.keys) && node.keys.length) push('关键词', node.keys.join('、'));
    if (relatedLinks.length) push('关联', relatedLinks.join('；'));
    return parts.join('\n').trim();
}

function buildMemoryGraphBookshelfDefinitions(graph = getMemoryGraph(), context = getContext()) {
    const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : [])
        .filter(node => node?.id && formatMemoryBookNodeChunk(node, graph));
    const scope = getBookshelfScope(context);
    const chapters = new Map([
        ['prologue', { title: '序章：最近摘要', chunks: [] }],
        ['character', { title: '第一章：人物档案', chunks: [] }],
        ['plot', { title: '第二章：剧情时间线', chunks: [] }],
        ['world', { title: '第三章：世界设定', chunks: [] }],
        ['relations', { title: '第四章：关系网络', chunks: [] }],
        ['state', { title: '第五章：当前状态', chunks: [] }],
        ['memory', { title: '附录：综合记忆', chunks: [] }],
    ]);

    const pushChapterChunk = (chapterKey, title, text, extra = {}) => {
        const chapter = chapters.get(chapterKey) || chapters.get('memory');
        const clean = String(text || '').trim();
        if (!clean) return;
        chapter.chunks.push({
            title: truncateText(title || `${chapter.title} ${chapter.chunks.length + 1}`, 70),
            text: clean,
            chapterKey,
            chapterTitle: chapter.title,
            ...extra,
        });
    };

    if (graph?.lastSummary) {
        pushChapterChunk('prologue', '最近剧情摘要', `最近摘要：${truncateText(graph.lastSummary, 1200)}`, { sourceType: 'summary' });
    }

    for (const node of nodes) {
        const config = getMemoryBookTypeConfig(node.type);
        pushChapterChunk(config.key, node.title || node.id, formatMemoryBookNodeChunk(node, graph), {
            sourceNodeId: String(node.id || ''),
            sourceType: String(node.type || ''),
        });
    }

    const links = Array.isArray(graph?.links) ? graph.links : [];
    if (links.length) {
        const nodeById = new Map(nodes.map(node => [String(node.id), node]));
        const relationLines = links.slice(-80).map(link => {
            const source = nodeById.get(String(link.source));
            const target = nodeById.get(String(link.target));
            return `${source?.title || link.source} --${link.type || 'RELATED'}--> ${target?.title || link.target}`;
        }).filter(Boolean);
        if (relationLines.length) {
            const relationText = relationLines.join('\n');
            splitTextIntoBookshelfChunks(relationText, { chunkSize: 520, overlap: 60 })
                .forEach((chunk, index) => {
                    pushChapterChunk('relations', chunk.title || `关系摘要 ${index + 1}`, chunk.text, { sourceType: 'relations' });
                });
        }
    }

    const stateParts = [];
    const stateValues = graph?.state?.custom_values || graph?.custom_values || {};
    for (const [key, value] of Object.entries(stateValues || {})) {
        const text = String(value ?? '').trim();
        if (text) stateParts.push(`${key}：${text}`);
    }
    if (stateParts.length) {
        splitTextIntoBookshelfChunks(stateParts.join('\n'), { chunkSize: 520, overlap: 60 })
            .forEach((chunk, index) => {
                pushChapterChunk('state', chunk.title || `状态摘要 ${index + 1}`, chunk.text, { sourceType: 'state' });
            });
    }

    const chunks = [];
    for (const [chapterKey, chapter] of chapters.entries()) {
        chapter.chunks.slice(0, 80).forEach((chunk, index) => {
            chunks.push({
                ...chunk,
                chapterKey,
                chapterTitle: chapter.title,
                title: `${chapter.title} · ${chunk.title || `片段 ${index + 1}`}`,
            });
        });
    }
    if (!chunks.length) return [];
    return [{
        key: 'chat_novel',
        type: 'memory',
        title: `记忆书：${scope.chatName || '当前聊天'}`,
        chapters: Array.from(chapters.values())
            .map(chapter => ({ title: chapter.title, count: chapter.chunks.length }))
            .filter(chapter => chapter.count),
        chunks: chunks.slice(0, 240),
    }];
}

async function syncMemoryGraphBookshelfBooks(graph = getMemoryGraph(), context = getContext(), options = {}) {
    const scope = getBookshelfScope(context);
    const chatKey = getCurrentChatMemoryKey(context);
    const definitions = buildMemoryGraphBookshelfDefinitions(graph, context);
    const [existingBooks, existingChunks] = await Promise.all([
        bookshelfGetAll('books').catch(() => []),
        bookshelfGetAll('chunks').catch(() => []),
    ]);
    const staleBooks = (existingBooks || []).filter(book => (
        book?.autoGenerated
        && book?.autoSource === 'memory-graph'
        && book?.autoChatKey === chatKey
    ));
    const reusableChunks = new Map();
    for (const book of staleBooks) {
        for (const chunk of (existingChunks || []).filter(item => item.bookId === book.id)) {
            const key = `${chunk.chapterTitle || ''}|${chunk.title || ''}|${chunk.textHash || hashString(chunk.text || '')}`;
            if (!reusableChunks.has(key)) reusableChunks.set(key, chunk);
        }
    }
    for (const book of staleBooks) {
        await bookshelfDeleteBook(book.id);
    }

    const now = new Date().toISOString();
    const provider = getBookshelfEmbeddingProviderMeta();
    const createdBooks = [];
    let totalChunks = 0;
    for (const definition of definitions) {
        const bookId = `auto_memory:${hashString(chatKey)}:${definition.key}`;
        const bindings = [
            { type: 'chat', key: scope.chatKey, label: scope.chatName || scope.chatKey, createdAt: now },
        ];
        const book = {
            id: bookId,
            title: definition.title,
            fileName: `${definition.title}.memory`,
            type: definition.type || 'memory',
            enabled: true,
            bindings,
            status: definition.chunks.length ? 'pending_vectorization' : 'empty',
            autoGenerated: true,
            autoSource: 'memory-graph',
            autoChatKey: chatKey,
            autoScope: 'chat',
            chapters: definition.chapters || [],
            sourceSummary: `当前聊天专属记忆书：${definition.chapters?.length || 0} 章，${definition.chunks.length} 个摘要片段`,
            embeddingMode: options.vectorize ? provider.mode : '',
            embeddingModel: options.vectorize ? provider.model : '',
            embeddingDim: 0,
            chunkCount: definition.chunks.length,
            vectorizedCount: 0,
            createdAt: now,
            updatedAt: now,
        };
        const chunks = definition.chunks.map((chunk, index) => {
            const title = chunk.title || `${definition.title} #${index + 1}`;
            const textHash = hashString(chunk.text);
            const previous = reusableChunks.get(`${chunk.chapterTitle || ''}|${title}|${textHash}`);
            const canReuseVector = previous
                && previous.textHash === textHash
                && previous.vectorStatus === 'ready'
                && Array.isArray(previous.vector)
                && previous.vector.length;
            return {
                id: `${bookId}:chunk:${index}`,
                bookId,
                index,
                order: index + 1,
                title,
                text: chunk.text,
                textHash,
                chapterKey: chunk.chapterKey || '',
                chapterTitle: chunk.chapterTitle || '',
                sourceNodeId: chunk.sourceNodeId || '',
                sourceType: chunk.sourceType || definition.key,
                enabled: true,
                vector: canReuseVector ? previous.vector : [],
                vectorStatus: canReuseVector ? 'ready' : 'pending',
                embeddingMode: canReuseVector ? previous.embeddingMode || '' : '',
                embeddingModel: canReuseVector ? previous.embeddingModel || '' : '',
                embeddingDim: canReuseVector ? previous.embeddingDim || previous.vector.length || 0 : 0,
                createdAt: previous?.createdAt || now,
                updatedAt: now,
            };
        });
        const readyCount = chunks.filter(chunk => chunk.vectorStatus === 'ready').length;
        book.status = chunks.length && readyCount === chunks.length ? 'ready' : readyCount > 0 ? 'partial_failed' : book.status;
        book.vectorizedCount = readyCount;
        const firstReady = chunks.find(chunk => chunk.vectorStatus === 'ready');
        if (firstReady) {
            book.embeddingMode = firstReady.embeddingMode || book.embeddingMode;
            book.embeddingModel = firstReady.embeddingModel || book.embeddingModel;
            book.embeddingDim = firstReady.embeddingDim || book.embeddingDim;
        }
        await bookshelfPut('books', book);
        if (chunks.length) await bookshelfPutMany('chunks', chunks);
        createdBooks.push(book);
        totalChunks += chunks.length;
    }

    if (options.vectorize) {
        for (const book of createdBooks) {
            await rebuildBookshelfBookVectors(book.id);
        }
    }
    return {
        books: createdBooks.length,
        chunks: totalChunks,
        deleted: staleBooks.length,
        bookIds: createdBooks.map(book => book.id),
    };
}

function scheduleBookshelfMemoryBookSync(context = getContext(), options = {}) {
    if (!settings.bookshelfAutoMemoryBook && !options.force) return;
    clearTimeout(bookshelfMemoryBookSyncTimer);
    const chatKey = getCurrentChatMemoryKey(context);
    bookshelfMemoryBookSyncTimer = setTimeout(async () => {
        try {
            if (getCurrentChatMemoryKey() !== chatKey) return;
            const graph = getMemoryGraph(context);
            const result = await syncMemoryGraphBookshelfBooks(graph, context, { vectorize: false });
            const orphanDeleted = await cleanupOrphanBookshelfMemoryBooks(context).catch(() => 0);
            const deletedCount = Number(result.deleted || 0) + Number(orphanDeleted || 0);
            if (!options.silent) {
                setBookshelfStatus(result.books
                    ? `记忆书已自动刷新：${result.books} 本，${result.chunks} 个小节。`
                    : `当前聊天暂无图谱内容，已清理旧记忆书 ${deletedCount} 本。`);
            }
            if ($('#ai_wbr_bookshelf_panel').length) {
                renderBookshelfPanel();
            }
        } catch (error) {
            console.warn(`${LOG_PREFIX} Auto memory book sync failed`, error);
            if (!options.silent) {
                setBookshelfStatus(`记忆书自动刷新失败：${error?.message || error}`);
            }
        }
    }, clampNumber(options.delayMs, 900, 100, 8000));
}

async function cleanupOrphanBookshelfMemoryBooks(context = getContext()) {
    const currentChatKey = getCurrentChatMemoryKey(context);
    const validChatKeys = new Set([currentChatKey]);
    for (const [chatKey, container] of Object.entries(settings.memoryContainersByChat || {})) {
        const graph = container?.graph || {};
        if (graph?.nodes?.length || graph?.links?.length || graph?.lastSummary) {
            validChatKeys.add(chatKey);
        }
    }
    const books = await bookshelfGetAll('books').catch(() => []);
    let deleted = 0;
    for (const book of books || []) {
        if (
            book?.autoGenerated
            && book?.autoSource === 'memory-graph'
            && book?.autoChatKey
            && !validChatKeys.has(book.autoChatKey)
        ) {
            await bookshelfDeleteBook(book.id);
            deleted += 1;
        }
    }
    return deleted;
}

function tokenizeBookshelfText(text) {
    const normalized = normalizeText(text).toLowerCase();
    const terms = extractQueryTerms(normalized).filter(item => item.length >= 2);
    const compact = normalized.replace(/\s+/g, '');
    const grams = [];
    const maxGrams = Math.min(compact.length - 1, 600);
    for (let i = 0; i < maxGrams; i += 2) {
        const gram = compact.slice(i, i + 2);
        if (gram.trim()) grams.push(gram);
    }
    return uniqueStrings([...terms, ...grams]).slice(0, 900);
}

function getBookshelfEmbeddingMode() {
    const mode = String(settings.bookshelfEmbeddingMode || 'api').trim();
    return mode === 'browser-local' ? 'browser-local' : 'api';
}

function getBookshelfEmbeddingProviderMeta() {
    const mode = getBookshelfEmbeddingMode();
    if (mode === 'browser-local') {
        return {
            mode,
            model: String(settings.bookshelfLocalModelId || defaultSettings.bookshelfLocalModelId).trim(),
            label: 'Browser local embedding model',
        };
    }
    return {
        mode,
        model: String(settings.bookshelfApiModel || '').trim(),
        label: 'API embedding model',
    };
}

function normalizeBookshelfVector(vector) {
    const values = Array.from(vector || []).map(value => Number(value)).filter(value => Number.isFinite(value));
    if (!values.length) {
        throw new Error('Embedding model returned an empty vector.');
    }
    const norm = Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0)) || 1;
    return values.map(value => Number((value / norm).toFixed(8)));
}

function parseBookshelfEmbeddingResponse(json) {
    const first = Array.isArray(json?.data) ? json.data[0] : null;
    const vector = first?.embedding || json?.embedding || json?.vector;
    return normalizeBookshelfVector(vector);
}

function getBookshelfEmbeddingApiUrl() {
    const base = normalizeUrl(settings.bookshelfApiUrl || '');
    if (!base) {
        throw new Error('Please enter the bookshelf API URL first.');
    }
    if (/\/embeddings$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/embeddings`;
    return `${base.replace(/\/$/, '')}/v1/embeddings`;
}

async function embedBookshelfTextByApi(text) {
    const model = String(settings.bookshelfApiModel || '').trim();
    if (!model) {
        throw new Error('Please enter the bookshelf API URL first.');
    }
    const apiUrl = getBookshelfEmbeddingApiUrl();
    const apiKey = String(settings.bookshelfApiKey || '').trim();
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: String(text || '') }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error('Please enter the bookshelf API URL first.');
    }
    return parseBookshelfEmbeddingResponse(await response.json());
}

async function getBookshelfLocalEmbeddingPipeline() {
    if (!bookshelfLocalPipelinePromise) {
        saveSetting('bookshelfLocalModelStatus', 'loading');
        bookshelfLocalPipelinePromise = import(`${BOOKSHELF_LOCAL_TRANSFORMERS_CDN}/dist/transformers.min.js`)
            .then(async ({ pipeline, env }) => {
                if (env?.allowLocalModels !== undefined) env.allowLocalModels = false;
                if (env?.useBrowserCache !== undefined) env.useBrowserCache = true;
                const modelId = String(settings.bookshelfLocalModelId || defaultSettings.bookshelfLocalModelId).trim();
                if (!modelId) {
                    throw new Error('Please enter the local embedding model ID first.');
                }
                const pipe = await pipeline('feature-extraction', modelId, { quantized: true });
                saveSetting('bookshelfLocalModelStatus', 'ready');
                return pipe;
            })
            .catch((error) => {
                bookshelfLocalPipelinePromise = null;
                saveSetting('bookshelfLocalModelStatus', 'failed');
                throw new Error(`浏览器本地模型加载失败：${error?.message || error}`);
            });
    }
    return bookshelfLocalPipelinePromise;
}

async function embedBookshelfTextByBrowserLocal(text) {
    const pipe = await getBookshelfLocalEmbeddingPipeline();
    const output = await pipe(String(text || ''), { pooling: 'mean', normalize: true });
    const values = output?.data || output?.tolist?.()?.[0] || output?.[0];
    return normalizeBookshelfVector(values);
}

async function embedBookshelfText(text) {
    const mode = getBookshelfEmbeddingMode();
    if (mode === 'browser-local') {
        return await embedBookshelfTextByBrowserLocal(text);
    }
    return await embedBookshelfTextByApi(text);
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
    const length = Math.min(a.length, b.length);
    let dot = 0;
    let an = 0;
    let bn = 0;
    for (let i = 0; i < length; i += 1) {
        const av = Number(a[i]) || 0;
        const bv = Number(b[i]) || 0;
        dot += av * bv;
        an += av * av;
        bn += bv * bv;
    }
    return an && bn ? dot / (Math.sqrt(an) * Math.sqrt(bn)) : 0;
}

function calcBookshelfKeywordScore(text, queryTerms) {
    const body = normalizeText(text).toLowerCase();
    const terms = uniqueStrings(queryTerms || []).filter(item => item.length >= 2);
    if (!terms.length) return 0;
    let hits = 0;
    for (const term of terms) {
        if (body.includes(String(term).toLowerCase())) hits += 1;
    }
    return hits / terms.length;
}

function buildBookshelfRecallQuery(recentMessages = [], mvuSummary = '') {
    const parts = [];
    for (const message of (recentMessages || []).slice(-6)) {
        const text = contentToText(message?.content ?? message?.mes ?? message?.message ?? message?.text ?? message);
        if (text) parts.push(text);
    }
    if (mvuSummary) parts.push(mvuSummary);
    return parts.join('\n').trim();
}

function tagRecallCandidate(item, sourceType) {
    if (!item || typeof item !== 'object') return item;
    const title = item.comment
        || item.title
        || item.book?.title
        || item.book?.fileName
        || item.keys?.primary?.[0]
        || item.uid
        || item.id
        || '';
    const primaryKeys = uniqueStrings([
        ...(Array.isArray(item.keys?.primary) ? item.keys.primary : []),
        title,
        item.book?.title,
        item.book?.fileName,
    ].filter(Boolean));
    const secondaryKeys = uniqueStrings([
        ...(Array.isArray(item.keys?.secondary) ? item.keys.secondary : []),
        sourceType,
        item.source,
        item.memoryType,
        item.title,
    ].filter(Boolean));
    const allKeys = uniqueStrings([
        ...(Array.isArray(item.keys?.all) ? item.keys.all : []),
        ...primaryKeys,
        ...secondaryKeys,
    ]);
    const score = Number(item.score || 0);
    const semanticScore = Number(item.semanticScore || 0);
    const keywordScore = Number(item.keywordScore || 0);
    const matchedKeys = Array.isArray(item.matchedKeys) ? item.matchedKeys : [];
    const reason = item.reason
        || (sourceType === 'memory-vector' ? `图谱向量命中：语义 ${semanticScore.toFixed(2)}，关键词 ${keywordScore.toFixed(2)}` : '')
        || (sourceType === 'bookshelf' ? `书架向量命中：语义 ${semanticScore.toFixed(2)}，关键词 ${keywordScore.toFixed(2)}` : '')
        || (matchedKeys.length ? `关键词命中：${matchedKeys.join(', ')}` : '')
        || `候选分数 ${score.toFixed(2)}`;
    return {
        ...item,
        sourceType,
        recallId: String(item.routerId || item.uid || item.id || title || ''),
        recallTitle: String(title || ''),
        recallScore: score,
        recallReason: reason,
        selectedBy: item.selectedBy || '',
        keys: {
            ...(item.keys || {}),
            primary: primaryKeys,
            secondary: secondaryKeys,
            all: allKeys,
        },
    };
}

function tagRecallCandidates(items = [], sourceType) {
    return (Array.isArray(items) ? items : []).map(item => tagRecallCandidate(item, sourceType));
}

function mergeMemoryVectorCandidates(keywordCandidates = [], vectorCandidates = []) {
    const merged = new Map();
    for (const item of [...keywordCandidates, ...vectorCandidates]) {
        const key = String(item?.uid || item?.routerId || item?.comment || '');
        if (!key) continue;
        const previous = merged.get(key);
        if (!previous || Number(item.score || 0) > Number(previous.score || 0)) {
            merged.set(key, item);
        }
    }
    return [...merged.values()]
        .sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)) || String(b.nodeRef?.updatedAt || '').localeCompare(String(a.nodeRef?.updatedAt || '')));
}

function mergeSelectedMemoryVectors(selectedMemories = [], selectedVectors = []) {
    const maxVectorItems = clampNumber(settings.bookshelfMemoryVectorMaxItems, defaultSettings.bookshelfMemoryVectorMaxItems, 1, 12);
    const merged = [...selectedMemories];
    const seen = new Set(merged.map(item => String(item?.uid || item?.routerId || '')));
    for (const item of selectedVectors.slice(0, maxVectorItems)) {
        const key = String(item?.uid || item?.routerId || '');
        if (!key || seen.has(key)) continue;
        merged.push({
            ...item,
            reason: item.reason || `向量召回命中，分数 ${Number(item.score || 0).toFixed(2)}`,
        });
        seen.add(key);
    }
    return merged;
}

async function recallBookshelfChunks(query, context = getContext(), options = {}) {
    const force = !!options.force;
    if (!force && (!settings.bookshelfEnabled || !settings.bookshelfAutoInject)) {
        return { candidates: [], selected: [] };
    }
    const queryText = String(query || '').trim();
    if (!queryText) return { candidates: [], selected: [] };

    const [books, chunks] = await Promise.all([
        bookshelfGetAll('books'),
        bookshelfGetAll('chunks'),
    ]);
    const availableBooks = new Map((books || [])
        .filter(book => isBookshelfBookAvailable(book, context))
        .map(book => [book.id, book]));
    if (!availableBooks.size) return { candidates: [], selected: [] };

    const queryVector = await embedBookshelfText(queryText);
    const queryTerms = tokenizeBookshelfText(queryText).slice(0, 40);
    const minScore = clampNumber(settings.bookshelfMinScore, defaultSettings.bookshelfMinScore, 0, 1);
    const maxChunks = clampNumber(settings.bookshelfMaxChunks, defaultSettings.bookshelfMaxChunks, 1, 12);

    const candidates = (chunks || [])
        .filter(chunk => chunk?.enabled !== false && availableBooks.has(chunk.bookId) && chunk.vectorStatus === 'ready' && Array.isArray(chunk.vector))
        .map(chunk => {
            const book = availableBooks.get(chunk.bookId);
            const semanticScore = Math.max(0, cosineSimilarity(queryVector, chunk.vector));
            const keywordScore = calcBookshelfKeywordScore(chunk.text, queryTerms);
            const score = Math.min(1, (semanticScore * 0.78) + (keywordScore * 0.22) + ((Number(chunk.weight) || 1) - 1) * 0.05);
            return {
                ...chunk,
                book,
                source: 'bookshelf',
                score,
                semanticScore,
                keywordScore,
                comment: book?.title || chunk.title || chunk.id,
                content: chunk.text,
                uid: chunk.id,
            };
        })
        .filter(item => item.score >= minScore)
        .sort((a, b) => b.score - a.score);

    return {
        candidates,
        selected: candidates.slice(0, maxChunks),
    };
}

function buildMemoryVectorText(node, graph = getMemoryGraph()) {
    const parts = [];
    const push = (label, value) => {
        const text = String(value || '').trim();
        if (text) parts.push(`${label}: ${text}`);
    };
    push('Title', node?.title);
    push('Type', node?.type);
    push('Summary', node?.summary);
    push('Content', node?.content);
    push('Location', node?.location);
    push('Time', node?.timeSpan);
    if (Array.isArray(node?.tags) && node.tags.length) push('Tags', node.tags.join(', '));
    if (Array.isArray(node?.keys) && node.keys.length) push('Keys', node.keys.join(', '));
    if (graph?.lastSummary) push('Recent summary', truncateText(graph.lastSummary, 360));
    return parts.join('\n').trim();
}
function buildMemoryVectorRecord(node, graph = getMemoryGraph(), context = getContext(), provider = getBookshelfEmbeddingProviderMeta()) {
    const chatKey = getCurrentChatMemoryKey(context);
    const text = buildMemoryVectorText(node, graph);
    const textHash = hashString(text);
    return {
        id: `memory:${chatKey}:${node.id}`,
        chatKey,
        nodeId: String(node.id || ''),
        title: String(node.title || node.id || '记忆节点'),
        memoryType: String(node.type || 'event'),
        text,
        textHash,
        vector: [],
        vectorStatus: text ? 'pending' : 'empty',
        embeddingMode: provider.mode,
        embeddingModel: provider.model,
        embeddingDim: 0,
        updatedAt: new Date().toISOString(),
    };
}

async function syncMemoryGraphVectors(graph = getMemoryGraph(), context = getContext(), options = {}) {
    if (!settings.bookshelfMemoryVectorRecall && !options.force) {
        return { total: 0, ready: 0, pending: 0, failed: 0, skipped: true };
    }
    const provider = getBookshelfEmbeddingProviderMeta();
    if (!provider.model) {
        throw new Error('Please enter the bookshelf API URL first.');
    }
    const chatKey = getCurrentChatMemoryKey(context);
    const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : [])
        .filter(node => node?.id && buildMemoryVectorText(node, graph));
    const existing = await bookshelfGetAll('memoryVectors').catch(() => []);
    const existingById = new Map((existing || [])
        .filter(item => item.chatKey === chatKey)
        .map(item => [item.id, item]));
    const liveIds = new Set(nodes.map(node => `memory:${chatKey}:${node.id}`));
    const staleIds = (existing || [])
        .filter(item => item.chatKey === chatKey && !liveIds.has(item.id))
        .map(item => item.id);

    for (const id of staleIds) {
        await bookshelfDelete('memoryVectors', id);
    }

    let ready = 0;
    let pending = 0;
    let failed = 0;
    const records = [];
    for (const node of nodes) {
        const base = buildMemoryVectorRecord(node, graph, context, provider);
        const previous = existingById.get(base.id);
        if (
            previous
            && previous.textHash === base.textHash
            && previous.embeddingMode === provider.mode
            && previous.embeddingModel === provider.model
            && previous.vectorStatus === 'ready'
            && Array.isArray(previous.vector)
            && previous.vector.length
            && !options.force
        ) {
            ready += 1;
            continue;
        }
        try {
            const vector = await embedBookshelfText(base.text);
            records.push({
                ...base,
                vector,
                vectorStatus: 'ready',
                embeddingDim: vector.length,
                error: '',
            });
            ready += 1;
        } catch (error) {
            records.push({
                ...base,
                vector: [],
                vectorStatus: 'failed',
                error: error?.message || String(error),
            });
            failed += 1;
        }
        pending += 1;
        if (records.length >= 6) {
            await bookshelfPutMany('memoryVectors', records.splice(0, records.length));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    if (records.length) {
        await bookshelfPutMany('memoryVectors', records);
    }
    return { total: nodes.length, ready, pending, failed, skipped: false };
}

async function recallMemoryVectorChunks(query, memoryGraph = getMemoryGraph(), context = getContext(), options = {}) {
    const force = !!options.force;
    if (!force && !settings.bookshelfMemoryVectorRecall) {
        return { candidates: [], selected: [], sync: null };
    }
    const queryText = String(query || '').trim();
    if (!queryText) return { candidates: [], selected: [], sync: null };

    const sync = await syncMemoryGraphVectors(memoryGraph, context, { force: !!options.forceRebuild });
    const chatKey = getCurrentChatMemoryKey(context);
    const [records, queryVector] = await Promise.all([
        bookshelfGetAll('memoryVectors'),
        embedBookshelfText(queryText),
    ]);
    const queryTerms = tokenizeBookshelfText(queryText).slice(0, 40);
    const minScore = clampNumber(settings.bookshelfMinScore, defaultSettings.bookshelfMinScore, 0, 1);
    const maxItems = clampNumber(settings.bookshelfMemoryVectorMaxItems, defaultSettings.bookshelfMemoryVectorMaxItems, 1, 12);
    const nodeById = new Map((Array.isArray(memoryGraph?.nodes) ? memoryGraph.nodes : []).map(node => [String(node.id), node]));
    const candidates = (records || [])
        .filter(item => item.chatKey === chatKey && item.vectorStatus === 'ready' && Array.isArray(item.vector) && item.vector.length)
        .map(item => {
            const semanticScore = Math.max(0, cosineSimilarity(queryVector, item.vector));
            const keywordScore = calcBookshelfKeywordScore(item.text, queryTerms);
            const node = nodeById.get(String(item.nodeId)) || {};
            const score = Math.min(1, (semanticScore * 0.82) + (keywordScore * 0.18));
            return {
                routerId: `memory-vector:${item.nodeId}`,
                uid: String(item.nodeId || item.id),
                source: 'memory-vector',
                world: 'memory-vector',
                comment: item.title || node.title || '图谱记忆',
                content: node.content || node.summary || item.text,
                keys: {
                    primary: uniqueStrings([item.title, node.title].filter(Boolean)),
                    secondary: uniqueStrings([
                        item.memoryType,
                        node.type,
                        ...(Array.isArray(node.tags) ? node.tags : []),
                        ...(Array.isArray(node.keys) ? node.keys : []),
                    ].filter(Boolean)),
                    all: uniqueStrings([
                        item.title,
                        node.title,
                        item.memoryType,
                        node.type,
                        ...(Array.isArray(node.tags) ? node.tags : []),
                        ...(Array.isArray(node.keys) ? node.keys : []),
                    ].filter(Boolean)),
                },
                matchedKeys: [],
                score,
                semanticScore,
                keywordScore,
                memoryType: item.memoryType || node.type || 'event',
                nodeRef: node,
                vectorRecord: item,
                reason: `向量召回：语义 ${semanticScore.toFixed(2)}，关键词 ${keywordScore.toFixed(2)}`,
            };
        })
        .filter(item => item.score >= minScore)
        .sort((a, b) => b.score - a.score);

    return {
        candidates,
        selected: candidates.slice(0, maxItems),
        sync,
    };
}

async function recallVectorMemoryAndBookshelf(query, memoryGraph = getMemoryGraph(), context = getContext(), options = {}) {
    const [memoryResult, bookshelfResult] = await Promise.all([
        recallMemoryVectorChunks(query, memoryGraph, context, options).catch(error => ({ candidates: [], selected: [], error })),
        recallBookshelfChunks(query, context, options).catch(error => ({ candidates: [], selected: [], error })),
    ]);
    if (memoryResult.error) {
        console.warn(`${LOG_PREFIX} Memory vector recall skipped.`, memoryResult.error);
    }
    if (bookshelfResult.error) {
        console.warn(`${LOG_PREFIX} Bookshelf recall skipped.`, bookshelfResult.error);
        setBookshelfStatus(`向量召回跳过：${bookshelfResult.error?.message || bookshelfResult.error}`);
    }
    return {
        memoryCandidates: memoryResult.candidates || [],
        selectedMemoryVectors: memoryResult.selected || [],
        bookshelfCandidates: bookshelfResult.candidates || [],
        selectedBookshelf: bookshelfResult.selected || [],
        errors: [memoryResult.error, bookshelfResult.error].filter(Boolean),
        sync: memoryResult.sync || null,
    };
}

async function buildUnifiedRecallBundle(context, recentMessages, options = {}) {
    const mvuSummary = options.mvuSummary ?? getCombinedStateSummary(context);
    const memoryGraph = options.memoryGraph || getMemoryGraph(context);
    const entries = await getWorldbookEntries(context);
    const wbCandidates = tagRecallCandidates(
        recallCandidates(entries, recentMessages, mvuSummary),
        'worldbook',
    );
    const keywordMemoryCandidates = tagRecallCandidates(
        recallMemoryCandidates(memoryGraph, recentMessages, mvuSummary),
        'memory-keyword',
    );

    let memoryCandidates = keywordMemoryCandidates;
    let bookshelfCandidates = [];
    let selectedBookshelf = [];
    let selectedMemoryVectors = [];
    let vectorErrors = [];
    let vectorSync = null;

    try {
        const query = buildBookshelfRecallQuery(recentMessages, mvuSummary);
        const vectorResult = await recallVectorMemoryAndBookshelf(query, memoryGraph, context, options);
        const vectorMemoryCandidates = tagRecallCandidates(vectorResult.memoryCandidates || [], 'memory-vector');
        memoryCandidates = mergeMemoryVectorCandidates(keywordMemoryCandidates, vectorMemoryCandidates);
        selectedMemoryVectors = tagRecallCandidates(vectorResult.selectedMemoryVectors || [], 'memory-vector');
        bookshelfCandidates = tagRecallCandidates(vectorResult.bookshelfCandidates || [], 'bookshelf');
        selectedBookshelf = tagRecallCandidates(vectorResult.selectedBookshelf || [], 'bookshelf');
        vectorErrors = vectorResult.errors || [];
        vectorSync = vectorResult.sync || null;
    } catch (error) {
        vectorErrors = [error];
        console.warn(`${LOG_PREFIX} Vector recall skipped.`, error);
        setBookshelfStatus(`向量召回跳过：${error?.message || error}`);
    }

    return {
        mvuSummary,
        memoryGraph,
        wbCandidates,
        memoryCandidates,
        bookshelfCandidates,
        selectedBookshelf,
        selectedMemoryVectors,
        combinedCandidates: [...wbCandidates, ...memoryCandidates, ...bookshelfCandidates],
        vectorErrors,
        vectorSync,
        pipeline: {
            preRefresh: options.preRefresh || null,
            graph: {
                nodes: Array.isArray(memoryGraph?.nodes) ? memoryGraph.nodes.length : 0,
                links: Array.isArray(memoryGraph?.links) ? memoryGraph.links.length : 0,
                hasState: hasMemoryState(memoryGraph),
                updatedAt: memoryGraph?.updatedAt || '',
            },
            recall: {
                worldbook: wbCandidates.length,
                memory: memoryCandidates.length,
                bookshelf: bookshelfCandidates.length,
                combined: wbCandidates.length + memoryCandidates.length + bookshelfCandidates.length,
                selectedMemoryVectors: selectedMemoryVectors.length,
                selectedBookshelf: selectedBookshelf.length,
            },
            vector: {
                sync: vectorSync,
                errors: vectorErrors.map(error => error?.message || String(error)),
            },
        },
    };
}

async function importBookshelfFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) {
        setBookshelfStatus('No files selected.');
        return;
    }

    const context = getContext();
    const scope = getBookshelfScope(context);
    const type = String($('[id="ai_wbr_bookshelf_import_type"]:visible').last().val() || $('[id="ai_wbr_bookshelf_import_type"]').last().val() || 'other');
    let imported = 0;
    let totalChunks = 0;
    setBookshelfStatus(`Importing ${list.length} TXT file(s)...`);

    for (const file of list) {
        const text = await readBookshelfTextFile(file);
        const rawTitle = file.name.replace(/\.[^.]+$/, '').trim() || 'Untitled book';
        const now = new Date().toISOString();
        const bookId = `book_${Date.now().toString(36)}_${hashString(`${file.name}:${file.size}:${text.slice(0, 200)}`)}`;
        const chunks = splitTextIntoBookshelfChunks(text, { chunkSize: 700, overlap: 100 });
        const bindings = [];

        const book = {
            id: bookId,
            title: rawTitle,
            fileName: file.name,
            type,
            enabled: true,
            bindings,
            status: chunks.length ? 'pending_vectorization' : 'empty',
            embeddingMode: '',
            embeddingModel: '',
            embeddingDim: 0,
            chunkCount: chunks.length,
            vectorizedCount: 0,
            createdAt: now,
            updatedAt: now,
        };
        const records = chunks.map((chunk, index) => {
            const textHash = hashString(chunk.text);
            return {
                id: `${bookId}:chunk:${index}` ,
                bookId,
                index,
                title: chunk.title || `${rawTitle} #${index + 1}`,
                text: chunk.text,
                textHash,
                vector: null,
                embeddingMode: '',
                embeddingModel: '',
                embeddingDim: 0,
                createdAt: now,
                updatedAt: now,
            };
        });

        if (settings.bookshelfOnlyBound) {
            if (scope.chatKey) bindings.push({ type: 'chat', key: scope.chatKey, label: scope.chatName || scope.chatKey, createdAt: now });
            else if (scope.characterKey) bindings.push({ type: 'character', key: scope.characterKey, label: scope.characterName || scope.characterKey, createdAt: now });
        }

        await bookshelfPut('books', book);
        if (records.length) await bookshelfPutMany('chunks', records);
        imported += 1;
        totalChunks += records.length;
    }

    bookshelfLastStatus = `Imported ${imported} book(s), ${totalChunks} chunk(s).`;
    setBookshelfStatus('Ready');
    renderBookshelfPanel();
}
async function updateBookshelfBook(bookId, mutator) {
    const book = await bookshelfGet('books', bookId);
    if (!book) return null;
    const next = {
        ...book,
        ...(typeof mutator === 'function' ? mutator(book) : mutator || {}),
        updatedAt: new Date().toISOString(),
    };
    await bookshelfPut('books', next);
    return next;
}

async function setBookshelfBinding(bookId, type) {
    const scope = getBookshelfScope();
    const binding = type === 'character'
        ? { type: 'character', key: scope.characterKey, label: scope.characterName || scope.characterKey || 'Character' }
        : type === 'chat'
            ? { type: 'chat', key: scope.chatKey, label: scope.chatName || scope.chatKey || 'Chat' }
            : { type: 'global', key: 'global', label: 'Global' };
    await updateBookshelfBook(bookId, (book) => {
        const bindings = normalizeBookshelfBindings(book).filter(item => !(item.type === binding.type && item.key === binding.key));
        bindings.push({ ...binding, createdAt: new Date().toISOString() });
        return { bindings };
    });
    renderBookshelfPanel();
}
async function removeBookshelfBinding(bookId, type) {
    const scope = getBookshelfScope();
    const key = type === 'character' ? scope.characterKey : type === 'chat' ? scope.chatKey : 'global';
    await updateBookshelfBook(bookId, (book) => ({
        bindings: normalizeBookshelfBindings(book).filter(item => !(item.type === type && item.key === key)),
    }));
    renderBookshelfPanel();
}

async function clearBookshelfBindings(bookId) {
    if (!bookId) return;
    await updateBookshelfBook(bookId, { bindings: [] });
    renderBookshelfPanel();
}

async function rebuildBookshelfBookVectors(bookId) {
    const [book, chunks] = await Promise.all([
        bookshelfGet('books', bookId),
        bookshelfGetAll('chunks'),
    ]);
    if (!book) return;
    const targets = (chunks || []).filter(chunk => chunk.bookId === bookId);
    if (!targets.length) {
        await updateBookshelfBook(bookId, { status: 'empty', vectorizedCount: 0, chunkCount: 0 });
        setBookshelfStatus('This book has no chunks to vectorize.');
        renderBookshelfPanel();
        return;
    }
    const provider = getBookshelfEmbeddingProviderMeta();
    if (!provider.model) {
        throw new Error('Please configure an embedding model first.');
    }
    bookshelfVectorAbortRequested = false;
    await updateBookshelfBook(bookId, {
        status: 'vectorizing',
        embeddingMode: provider.mode,
        embeddingModel: provider.model,
        vectorizedCount: targets.filter(chunk => chunk.vectorStatus === 'ready' && Array.isArray(chunk.vector) && chunk.vector.length).length,
        chunkCount: targets.length,
    });
    setBookshelfStatus(`Vectorizing ${book.title || book.fileName}: 0 / ${targets.length} (${provider.label})`);
    let done = 0;
    let failed = 0;
    let dim = 0;
    const batch = [];
    for (let index = 0; index < targets.length; index += 1) {
        if (bookshelfVectorAbortRequested) break;
        const chunk = targets[index];
        try {
            const vector = await embedBookshelfText(chunk.text);
            dim = vector.length || dim;
            batch.push({
                ...chunk,
                textHash: hashString(chunk.text),
                vector,
                vectorStatus: 'ready',
                embeddingMode: provider.mode,
                embeddingModel: provider.model,
                embeddingDim: vector.length,
                error: '',
                updatedAt: new Date().toISOString(),
            });
            done += 1;
        } catch (error) {
            failed += 1;
            batch.push({
                ...chunk,
                vector: [],
                vectorStatus: 'failed',
                embeddingMode: provider.mode,
                embeddingModel: provider.model,
                embeddingDim: 0,
                error: error?.message || String(error),
                updatedAt: new Date().toISOString(),
            });
        }
        if (batch.length >= 8 || index === targets.length - 1) {
            await bookshelfPutMany('chunks', batch.splice(0, batch.length));
            await updateBookshelfBook(bookId, {
                status: failed ? 'partial_failed' : 'vectorizing',
                embeddingMode: provider.mode,
                embeddingModel: provider.model,
                embeddingDim: dim,
                vectorizedCount: done,
                chunkCount: targets.length,
            });
            setBookshelfStatus(`Vectorizing ${book.title || book.fileName}: ${done} / ${targets.length}${failed ? `, failed ${failed}` : ''}`);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    const finalStatus = done === targets.length ? 'ready' : done > 0 ? 'partial_failed' : 'failed';
    await updateBookshelfBook(bookId, {
        status: finalStatus,
        embeddingMode: provider.mode,
        embeddingModel: provider.model,
        embeddingDim: dim,
        chunkCount: targets.length,
        vectorizedCount: done,
    });
    setBookshelfStatus(`Vectorization complete for ${book.title || book.fileName}: ${done} / ${targets.length}${failed ? `, failed ${failed}` : ''}.`);
    renderBookshelfPanel();
}

async function clearBookshelfBookVectors(bookId) {
    const [book, chunks] = await Promise.all([
        bookshelfGet('books', bookId),
        bookshelfGetAll('chunks'),
    ]);
    if (!book) return;
    const now = new Date().toISOString();
    const cleared = (chunks || []).filter(chunk => chunk.bookId === bookId).map(chunk => ({
        ...chunk,
        textHash: hashString(chunk.text),
        vector: [],
        vectorStatus: 'pending',
        embeddingMode: '',
        embeddingModel: '',
        embeddingDim: 0,
        error: '',
        updatedAt: now,
    }));
    if (cleared.length) await bookshelfPutMany('chunks', cleared);
    await updateBookshelfBook(bookId, {
        status: cleared.length ? 'pending_vectorization' : 'empty',
        embeddingMode: '',
        embeddingModel: '',
        embeddingDim: 0,
        chunkCount: cleared.length,
        vectorizedCount: 0,
    });
    setBookshelfStatus(`Reset ${book.title || book.fileName} to pending vectorization.`);
    renderBookshelfPanel();
}
function getLegacyChatMemoryKeys(context = getContext()) {
    const keys = [];
    const add = (key) => {
        const value = String(key || '').trim();
        if (value && !keys.includes(value)) {
            keys.push(value);
        }
    };

    const { scopeParts, stableChatParts } = getStableChatScopeParts(context);
    if (stableChatParts.length) {
        add(`chat:${[...scopeParts, ...stableChatParts].join('|')}`);
    }

    const weakParts = [];
    for (const candidate of [context?.chatMetadata?.chat_name, context?.chatMetadata?.name]) {
        const value = String(candidate ?? '').trim();
        if (value && !weakParts.includes(value)) {
            weakParts.push(value);
        }
    }
    if (weakParts.length) {
        add(`chat:weak:${[...scopeParts, ...weakParts].join('|')}`);
    }

    const chat = Array.isArray(context?.chat) ? context.chat : [];
    if (chat.length) {
        const fingerprint = chat
            .slice(0, 6)
            .map(item => `${item?.is_user ? 'u' : 'a'}:${item?.name || ''}:${item?.mes || item?.text || ''}`)
            .join('\n');
        if (fingerprint.trim()) {
            add(`chat:fallback:${hashString(`${scopeParts.join('|')}|${fingerprint}`)}`);
        }
    }

    add('chat:default');
    return keys;
}

function hasUsefulMemoryContainer(container) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) {
        return false;
    }
    const normalized = normalizeChatMemoryContainer(container);
    return !!(
        normalized.graph?.nodes?.length
        || normalized.graph?.links?.length
        || hasMemoryState(normalized.graph)
        || normalized.reviewQueue?.length
        || normalized.lastPrompt
        || normalized.lastRaw
        || normalized.lastError
        || normalized.status
    );
}

function hasUsefulMemoryGraph(graph) {
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
        return false;
    }
    const safeGraph = cloneMemoryGraph(graph);
    return !!(
        (Array.isArray(safeGraph.nodes) && safeGraph.nodes.length)
        || (Array.isArray(safeGraph.links) && safeGraph.links.length)
        || hasMemoryState(safeGraph)
        || String(safeGraph.lastSummary || '').trim()
    );
}

function cloneMemoryContainerForScope(container, chatKey) {
    const normalized = normalizeChatMemoryContainer(container);
    normalized.chatKey = chatKey;
    normalized.migratedAt = normalized.migratedAt || new Date().toISOString();
    normalized.migratedFrom = normalized.migratedFrom || String(container?.chatKey || 'legacy');
    return normalized;
}

function cloneMemoryGraph(graph) {
    try {
        return JSON.parse(JSON.stringify(graph || getDefaultMemoryGraph()));
    } catch {
        return getDefaultMemoryGraph();
    }
}

function normalizeMemoryStateDefinition(definition, index = 0) {
    const rawLabel = String(definition?.label || definition?.name || '').trim();
    const rawInstruction = String(definition?.instruction || definition?.desc || definition?.description || '').trim();
    const label = truncateText(rawLabel || `自定义字段${index + 1}`, 40);
    const keyBase = String(definition?.key || createMemoryId(rawLabel || rawInstruction || `custom_state_${index + 1}`, 'custom_state')).trim();
    const key = keyBase.startsWith('custom_') ? keyBase : `custom_${keyBase}`;
    return {
        key,
        label,
        instruction: truncateText(rawInstruction, 140),
    };
}

function getCustomMemoryStateDefinitions(graph) {
    return (Array.isArray(graph?.stateDefinitions) ? graph.stateDefinitions : [])
        .map((definition, index) => normalizeMemoryStateDefinition(definition, index))
        .filter((definition, index, array) => definition.label && array.findIndex(item => item.key === definition.key) === index);
}

function getChatMemoryFirstMessage(context = getContext()) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const first = chat[0];
    return first && typeof first === 'object' ? first : null;
}

function normalizeChatMemoryContainer(container) {
    const normalized = container && typeof container === 'object' && !Array.isArray(container)
        ? { ...container }
        : {};
    normalized.version = Number(normalized.version || 1);
    normalized.graph = cloneMemoryGraph(normalized.graph || getDefaultMemoryGraph());
    normalized.graph.stateDefinitions = getCustomMemoryStateDefinitions(normalized.graph);
    normalized.graph.state = {
        ...getDefaultMemoryGraph().state,
        ...(normalized.graph.state && typeof normalized.graph.state === 'object' ? normalized.graph.state : {}),
    };
    normalized.graph.state.custom_values = normalized.graph.state.custom_values && typeof normalized.graph.state.custom_values === 'object'
        ? { ...normalized.graph.state.custom_values }
        : {};
    normalized.graphBackup = normalized.graphBackup && typeof normalized.graphBackup === 'object'
        ? cloneMemoryGraph(normalized.graphBackup)
        : null;
    normalized.chatKey = String(normalized.chatKey || '');
    normalized.lastAutoMessageCount = clampNumber(normalized.lastAutoMessageCount, 0, 0, 1000000);
    normalized.lastSummaryMessageCount = clampNumber(normalized.lastSummaryMessageCount, 0, 0, 1000000);
    normalized.status = String(normalized.status || '');
    normalized.lastTurnSignature = String(normalized.lastTurnSignature || '');
    normalized.lastPrompt = String(normalized.lastPrompt || '');
    normalized.lastRaw = String(normalized.lastRaw || '');
    normalized.lastError = String(normalized.lastError || '');
    normalized.historyImports = Array.isArray(normalized.historyImports)
        ? normalized.historyImports.filter(item => item && typeof item === 'object').slice(0, 120)
        : [];
    normalized.reviewQueue = Array.isArray(normalized.reviewQueue)
        ? normalized.reviewQueue.filter(item => item && typeof item === 'object').slice(0, 40)
        : [];
    return normalized;
}

function getChatMemoryContainer(context = getContext()) {
    const currentChatKey = getCurrentChatMemoryKey(context);
    const storedContainer = settings.memoryContainersByChat?.[currentChatKey];
    if (storedContainer && typeof storedContainer === 'object' && !Array.isArray(storedContainer)) {
        const normalizedStored = normalizeChatMemoryContainer(storedContainer);
        normalizedStored.chatKey = currentChatKey;
        if (hasUsefulMemoryContainer(normalizedStored)) {
            memoryScopeDebugLog('getChatMemoryContainer from settings map', {
                chatKey: currentChatKey,
                graph: getMemoryGraphSummary(normalizedStored.graph),
            }, context);
            return normalizedStored;
        }
        memoryScopeDebugLog('getChatMemoryContainer ignored empty settings map container', {
            chatKey: currentChatKey,
            graph: getMemoryGraphSummary(normalizedStored.graph),
        }, context);
    }

    const legacyChatKeys = getLegacyChatMemoryKeys(context);
    for (const legacyKey of legacyChatKeys) {
        const legacyContainer = settings.memoryContainersByChat?.[legacyKey];
        if (!hasUsefulMemoryContainer(legacyContainer)) {
            continue;
        }
        const migrated = cloneMemoryContainerForScope(legacyContainer, currentChatKey);
        settings.memoryContainersByChat[currentChatKey] = migrated;
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        memoryScopeDebugLog('getChatMemoryContainer migrated from legacy settings key', {
            legacyKey,
            currentChatKey,
            graph: getMemoryGraphSummary(migrated.graph),
        }, context);
        return migrated;
    }

    const first = getChatMemoryFirstMessage(context);
    if (!first) {
        memoryScopeDebugLog('getChatMemoryContainer no first message', {}, context);
        const empty = normalizeChatMemoryContainer(null);
        empty.chatKey = currentChatKey;
        return empty;
    }

    const raw = first[CHAT_MEMORY_FIELD];
    const parsed = typeof raw === 'string'
        ? (() => {
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        })()
        : raw;

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const normalized = normalizeChatMemoryContainer(parsed);
        if (normalized.chatKey && normalized.chatKey !== currentChatKey) {
            memoryScopeDebugLog('getChatMemoryContainer migrated mismatched chat[0] key', {
                storedChatKey: normalized.chatKey,
                currentChatKey,
                graph: getMemoryGraphSummary(normalized.graph),
            }, context);
        }
        if (!normalized.chatKey && (normalized.graph?.nodes?.length || normalized.graph?.links?.length || hasMemoryState(normalized.graph))) {
            const legacySignature = hashString(JSON.stringify(getMemoryGraphSummary(normalized.graph)));
            const legacyOwnerKey = settings.memoryLegacyGraphChatKeys?.[legacySignature];
            if (legacyOwnerKey && legacyOwnerKey !== currentChatKey) {
                memoryScopeDebugLog('getChatMemoryContainer reusing legacy graph for stable scope', {
                    legacyOwnerKey,
                    currentChatKey,
                    graph: getMemoryGraphSummary(normalized.graph),
                }, context);
            }
            settings.memoryLegacyGraphChatKeys[legacySignature] = currentChatKey;
        }
        normalized.chatKey = currentChatKey;
        settings.memoryContainersByChat[currentChatKey] = normalized;
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        memoryScopeDebugLog('getChatMemoryContainer from chat[0]', {
            rawType: typeof raw,
            chatKey: normalized.chatKey,
            graph: getMemoryGraphSummary(normalized.graph),
        }, context);
        return normalized;
    }

    for (const legacyKey of [currentChatKey, ...legacyChatKeys]) {
        const legacyGraph = settings.memoryGraphsByChat?.[legacyKey];
        if (!hasUsefulMemoryGraph(legacyGraph)) {
            continue;
        }
        const migrated = normalizeChatMemoryContainer({ graph: legacyGraph, chatKey: currentChatKey });
        migrated.migratedAt = new Date().toISOString();
        migrated.migratedFrom = `memoryGraphsByChat:${legacyKey}`;
        settings.memoryContainersByChat[currentChatKey] = migrated;
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        memoryScopeDebugLog('getChatMemoryContainer migrated from legacy graph map', {
            legacyKey,
            currentChatKey,
            graph: getMemoryGraphSummary(migrated.graph),
        }, context);
        return migrated;
    }

    if (hasUsefulMemoryGraph(settings.memoryGraph)) {
        const migrated = normalizeChatMemoryContainer({ graph: settings.memoryGraph, chatKey: currentChatKey });
        migrated.migratedAt = new Date().toISOString();
        migrated.migratedFrom = 'memoryGraph';
        settings.memoryContainersByChat[currentChatKey] = migrated;
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        memoryScopeDebugLog('getChatMemoryContainer migrated from global memoryGraph fallback', {
            currentChatKey,
            graph: getMemoryGraphSummary(migrated.graph),
        }, context);
        return migrated;
    }

    memoryScopeDebugLog('getChatMemoryContainer empty/default', {
        rawType: raw === undefined ? 'undefined' : typeof raw,
        rawPreview: typeof raw === 'string' ? raw.slice(0, 180) : JSON.stringify(raw || null).slice(0, 180),
    }, context);
    const empty = normalizeChatMemoryContainer(null);
    empty.chatKey = currentChatKey;
    return empty;
}

function persistChatMemoryContainer(container, context = getContext()) {
    const chatKey = getCurrentChatMemoryKey(context);
    const normalized = normalizeChatMemoryContainer(container);
    normalized.chatKey = chatKey;
    settings.memoryContainersByChat[chatKey] = normalized;
    settings.memoryGraphsByChat[chatKey] = cloneMemoryGraph(normalized.graph);
    settings.memoryGraph = normalized.graph;
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();

    const first = getChatMemoryFirstMessage(context);
    if (!first) {
        memoryScopeDebugLog('persistChatMemoryContainer skipped no first message', {}, context);
        return;
    }

    first[CHAT_MEMORY_FIELD] = normalized;
    memoryScopeDebugLog('persistChatMemoryContainer wrote chat[0]', {
        chatKey: normalized.chatKey,
        graph: getMemoryGraphSummary(first[CHAT_MEMORY_FIELD]?.graph),
        hasSaveChat: typeof context?.saveChat === 'function',
    }, context);
    if (typeof context?.saveChat === 'function') {
        Promise.resolve(context.saveChat()).catch((error) => {
            console.warn(`${LOG_PREFIX} Failed to save chat memory container`, error);
        });
    }
}

function getPerChatMemoryValue(storeName, fallbackValue, context = getContext()) {
    const container = getChatMemoryContainer(context);
    const fieldMap = {
        memoryStatusesByChat: 'status',
        memoryLastTurnSignaturesByChat: 'lastTurnSignature',
        memoryLastPromptsByChat: 'lastPrompt',
        memoryLastRawByChat: 'lastRaw',
        memoryLastErrorsByChat: 'lastError',
    };
    const field = fieldMap[storeName];
    if (!field) {
        return fallbackValue;
    }
    return container[field] ?? fallbackValue;
}

function setPerChatMemoryValue(storeName, value, context = getContext()) {
    const fieldMap = {
        memoryStatusesByChat: 'status',
        memoryLastTurnSignaturesByChat: 'lastTurnSignature',
        memoryLastPromptsByChat: 'lastPrompt',
        memoryLastRawByChat: 'lastRaw',
        memoryLastErrorsByChat: 'lastError',
    };
    const field = fieldMap[storeName];
    if (!field) {
        return;
    }
    const container = getChatMemoryContainer(context);
    container[field] = value;
    persistChatMemoryContainer(container, context);
}

function getCurrentMemoryStatus(context = getContext()) {
    return String(getPerChatMemoryValue('memoryStatusesByChat', settings.memoryStatus || '', context) || '');
}

function setCurrentMemoryStatus(text, context = getContext()) {
    setPerChatMemoryValue('memoryStatusesByChat', String(text || ''), context);
}

function getCurrentMemoryLastTurnSignature(context = getContext()) {
    return String(getPerChatMemoryValue('memoryLastTurnSignaturesByChat', settings.memoryLastTurnSignature || '', context) || '');
}

function setCurrentMemoryLastTurnSignature(value, context = getContext()) {
    setPerChatMemoryValue('memoryLastTurnSignaturesByChat', String(value || ''), context);
}

function getCurrentMemoryLastPrompt(context = getContext()) {
    return String(getPerChatMemoryValue('memoryLastPromptsByChat', settings.memoryLastPrompt || '', context) || '');
}

function setCurrentMemoryLastPrompt(value, context = getContext()) {
    setPerChatMemoryValue('memoryLastPromptsByChat', String(value || ''), context);
}

function getCurrentMemoryLastRaw(context = getContext()) {
    return String(getPerChatMemoryValue('memoryLastRawByChat', settings.memoryLastRaw || '', context) || '');
}

function setCurrentMemoryLastRaw(value, context = getContext()) {
    setPerChatMemoryValue('memoryLastRawByChat', String(value || ''), context);
}

function getCurrentMemoryLastError(context = getContext()) {
    return String(getPerChatMemoryValue('memoryLastErrorsByChat', settings.memoryLastError || '', context) || '');
}

function setCurrentMemoryLastError(value, context = getContext()) {
    setPerChatMemoryValue('memoryLastErrorsByChat', String(value || ''), context);
}

function getMemoryGraph(context = getContext()) {
    const container = getChatMemoryContainer(context);
    const graph = container.graph || getDefaultMemoryGraph();
    graph.version = Number(graph.version || 1);
    graph.state = {
        ...getDefaultMemoryGraph().state,
        ...(graph.state && typeof graph.state === 'object' ? graph.state : {}),
    };
    graph.state.custom_values = graph.state.custom_values && typeof graph.state.custom_values === 'object'
        ? { ...graph.state.custom_values }
        : {};
    graph.state.active_topics = uniqueStrings(Array.isArray(graph.state.active_topics) ? graph.state.active_topics : []);
    graph.state.open_questions = uniqueStrings(Array.isArray(graph.state.open_questions) ? graph.state.open_questions : []);
    graph.stateDefinitions = getCustomMemoryStateDefinitions(graph);
    graph.nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    graph.links = Array.isArray(graph.links) ? graph.links : [];
    graph.lastSummary = String(graph.lastSummary || '');
    graph.updatedAt = String(graph.updatedAt || '');
    return graph;
}

function saveMemoryGraph(graph = getMemoryGraph(), context = getContext(), skipRender = false) {
    const container = getChatMemoryContainer(context);
    container.graph = graph;
    persistChatMemoryContainer(container, context);
    settings.memoryGraph = graph;
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
    scheduleBookshelfMemoryBookSync(context, { silent: true, delayMs: 1200 });
    if (!skipRender) {
        renderMemoryPanel();
    }
}

function getMemoryReviewQueue(context = getContext()) {
    const container = getChatMemoryContainer(context);
    return Array.isArray(container.reviewQueue) ? container.reviewQueue : [];
}

function summarizeMemoryUpdateProposal(update) {
    const nodes = Array.isArray(update?.nodes) ? update.nodes : [];
    const updates = Array.isArray(update?.updates) ? update.updates : [];
    const links = Array.isArray(update?.links) ? update.links : [];
    const removes = [
        ...(Array.isArray(update?.remove_node_ids) ? update.remove_node_ids : []),
        ...(Array.isArray(update?.remove_link_ids) ? update.remove_link_ids : []),
    ];
    const state = update?.state && typeof update.state === 'object' ? update.state : {};
    const stateChanges = Object.entries(state).filter(([, value]) => {
        if (Array.isArray(value)) return value.length > 0;
        if (value && typeof value === 'object') return Object.keys(value).length > 0;
        return String(value || '').trim();
    }).length;
    return {
        nodes: nodes.length,
        updates: updates.length,
        links: links.length,
        removes: removes.length,
        stateChanges,
        title: truncateText(update?.summary || nodes[0]?.title || updates[0]?.title || 'Pending memory update', 80),
    };
}

function enqueueMemoryReview(update, meta = {}, context = getContext()) {
    const container = getChatMemoryContainer(context);
    const now = new Date().toISOString();
    const summary = summarizeMemoryUpdateProposal(update);
    const source = meta.source && typeof meta.source === 'object' ? meta.source : null;
    const item = {
        id: `review_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        status: 'pending',
        reason: String(meta.reason || 'auto'),
        signature: String(meta.signature || ''),
        source,
        createdAt: now,
        title: summary.title,
        summary,
        update,
        prompt: truncateText(meta.prompt || '', 4000),
        raw: truncateText(meta.raw || '', 4000),
    };
    container.reviewQueue = [item, ...(Array.isArray(container.reviewQueue) ? container.reviewQueue : [])].slice(0, 40);
    persistChatMemoryContainer(container, context);
    return item;
}

function removeMemoryReviewItem(id, context = getContext()) {
    const container = getChatMemoryContainer(context);
    container.reviewQueue = getMemoryReviewQueue(context).filter(item => String(item.id) !== String(id));
    persistChatMemoryContainer(container, context);
}

function acceptMemoryReviewItem(id, context = getContext()) {
    const item = getMemoryReviewQueue(context).find(entry => String(entry.id) === String(id));
    if (!item) return null;
    const sourceInvalidated = item.source?.id && getInvalidatedMemorySourceIds(item.source.chatKey || getCurrentChatMemoryKey(context)).includes(String(item.source.id));
    if (item.status === 'stale' || sourceInvalidated || (item.source?.chatKey && item.source.chatKey !== getCurrentChatMemoryKey(context))) {
        const container = getChatMemoryContainer(context);
        container.reviewQueue = getMemoryReviewQueue(context).map(entry => String(entry.id) === String(id)
            ? { ...entry, status: 'stale', staleReason: entry.staleReason || 'source_changed' }
            : entry);
        persistChatMemoryContainer(container, context);
        setMemoryStatus('记忆来源楼层已变化，本条待确认已失效', context);
        return null;
    }
    const container = getChatMemoryContainer(context);
    container.graphBackup = cloneMemoryGraph(getMemoryGraph(context));
    persistChatMemoryContainer(container, context);
    const result = applyMemoryGraphUpdate(item.update, context);
    removeMemoryReviewItem(id, context);
    return result;
}

function rejectMemoryReviewItem(id, context = getContext()) {
    removeMemoryReviewItem(id, context);
}

function acceptAllMemoryReviews(context = getContext()) {
    const queue = [...getMemoryReviewQueue(context)];
    let lastResult = null;
    let acceptedCount = 0;
    for (const item of queue) {
        const result = acceptMemoryReviewItem(item.id, context);
        if (result) {
            acceptedCount += 1;
            lastResult = result;
        }
    }
    return { count: acceptedCount, result: lastResult };
}

function clearMemoryReviewQueue(context = getContext()) {
    const container = getChatMemoryContainer(context);
    const count = getMemoryReviewQueue(context).length;
    container.reviewQueue = [];
    persistChatMemoryContainer(container, context);
    return count;
}

function setMemoryStatus(text, context = getContext()) {
    settings.memoryStatus = String(text || '');
    setCurrentMemoryStatus(text, context);
    $('#ai_wbr_memory_status').text(getCurrentMemoryStatus(context));
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
        summary: truncateText(rawNode?.summary || title, 120),
        location: truncateText(rawNode?.location || rawNode?.scene || '', 120),
        timeSpan: truncateText(rawNode?.timeSpan || rawNode?.time_span || rawNode?.time || '', 120),
        keys: uniqueStrings(Array.isArray(rawNode?.keys)
            ? rawNode.keys
            : String(rawNode?.keys || '').split(/[,\n;]+/u)),
        tags: uniqueStrings(Array.isArray(rawNode?.tags)
            ? rawNode.tags
            : String(rawNode?.tags || '').split(/[,\n;]+/u)),
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

function isWeakMemoryTitle(title) {
    const text = normalizeText(title);
    if (!text || text.length < 2) return true;
    return /^(本轮关键事件|关键事件|记忆|事件|摘要|本轮摘要|未命名|unknown|memory|event)$/iu.test(text);
}

function isValidMemoryNodeForApply(node) {
    if (!node || isWeakMemoryTitle(node.title)) return false;
    const body = normalizeText(`${node.content || ''} ${node.summary || ''}`);
    const hasSubstance = body.length >= 4 || (Array.isArray(node.keys) && node.keys.join('').length >= 2);
    return hasSubstance;
}

function sanitizeMemoryUpdateForApply(update) {
    const sanitized = {
        ...update,
        nodes: [],
        updates: [],
        links: [],
    };
    for (const rawNode of (Array.isArray(update?.nodes) ? update.nodes : []).slice(0, 8)) {
        const title = truncateText(rawNode?.title || rawNode?.label || rawNode?.id || '', 80);
        const summary = truncateText(rawNode?.summary || rawNode?.content || rawNode?.description || '', 240);
        const keys = Array.isArray(rawNode?.keys) ? rawNode.keys.join('') : String(rawNode?.keys || '');
        if (isWeakMemoryTitle(title) || (normalizeText(summary).length < 4 && normalizeText(keys).length < 2)) continue;
        sanitized.nodes.push(rawNode);
    }

    for (const rawUpdate of (Array.isArray(update?.updates) ? update.updates : []).slice(0, 8)) {
        const title = rawUpdate?.title || rawUpdate?.titleToUpdate || rawUpdate?.id || '';
        const content = rawUpdate?.content || rawUpdate?.newContent || rawUpdate?.summary || '';
        const keys = Array.isArray(rawUpdate?.keys) ? rawUpdate.keys.join('') : String(rawUpdate?.keys || '');
        if (isWeakMemoryTitle(title) || (normalizeText(content).length < 4 && normalizeText(keys).length < 2)) continue;
        sanitized.updates.push(rawUpdate);
    }

    for (const rawLink of (Array.isArray(update?.links) ? update.links : []).slice(0, 12)) {
        const source = normalizeText(rawLink?.source || rawLink?.sourceId || rawLink?.from || '');
        const target = normalizeText(rawLink?.target || rawLink?.targetId || rawLink?.to || '');
        if (!source || !target || source === target) continue;
        sanitized.links.push(rawLink);
    }

    return sanitized;
}

function memoryUpdateHasVisibleContent(update) {
    if (!update || typeof update !== 'object') {
        return false;
    }
    if (Array.isArray(update.nodes) && update.nodes.length) return true;
    if (Array.isArray(update.updates) && update.updates.length) return true;
    if (String(update.summary || '').trim()) return true;
    const state = update.state && typeof update.state === 'object' ? update.state : {};
    return Object.values(state).some((value) => {
        if (Array.isArray(value)) return value.length > 0;
        if (value && typeof value === 'object') return Object.keys(value).length > 0;
        return String(value || '').trim();
    });
}

function createMemoryFallbackSummaryFromMessages(messages, mode = 'realtime') {
    const usefulMessages = (Array.isArray(messages) ? messages : [])
        .map(message => sanitizeMemoryMessageText(message?.text || message?.mes || ''))
        .filter(Boolean)
        .slice(-4);
    if (!usefulMessages.length) {
        return '';
    }
    const label = mode === 'summary' || mode === 'history' ? '阶段整理' : '实时整理';
    return truncateText(`${label}: ${usefulMessages.map(text => truncateText(text, 180)).join('\n')}`, 900);
}

function ensureMemoryUpdateHasVisibleFallback(update, messages, mode = 'realtime') {
    if (memoryUpdateHasVisibleContent(update)) {
        return update;
    }
    const summary = createMemoryFallbackSummaryFromMessages(messages, mode);
    if (!summary) {
        return update;
    }
    return {
        ...(update && typeof update === 'object' ? update : {}),
        summary,
        nodes: [{
            id: `event_${Date.now().toString(36)}`,
            title: mode === 'summary' || mode === 'history' ? '阶段剧情整理' : '最新剧情进展',
            type: 'event',
            summary: truncateText(summary, 160),
            content: summary,
            tags: ['auto_memory'],
            importance: 0.55,
            credibility: 0.75,
        }],
    };
}

function createMemoryFallbackNodeFromSummary(summary, fallbackIndex = 0) {
    const text = String(summary || '').trim();
    if (normalizeText(text).length < 8) return null;
    let title = truncateText(text.split(/[。.!?\n]/u).find(part => normalizeText(part).length >= 4) || text, 48);
    if (isWeakMemoryTitle(title)) {
        title = `剧情进展 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return normalizeMemoryNode({
        id: `event_${Date.now().toString(36)}_${fallbackIndex}`,
        title,
        type: 'event',
        summary: title,
        content: text,
        tags: ['自动摘要'],
        importance: 0.52,
        credibility: 0.72,
    }, fallbackIndex);
}

function getRecentMessagesByCount(chat, count) {
    const limit = clampNumber(count, 6, 2, 40);
    return chat
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message && !message.is_system && message.mes)
        .slice(-limit)
        .map(({ message, index }) => ({
            index,
            messageId: String(message.id || message.messageId || message.extra?.id || message.send_date || ''),
            swipeId: String(message.swipe_id ?? message.swipeId ?? message.extra?.swipe_id ?? message.extra?.swipeId ?? ''),
            name: message.name || '',
            text: message.is_user ? extractActualUserInput(message.mes) : String(message.mes || ''),
            isUser: !!message.is_user,
        }));
}

function sanitizeMemoryMessageText(value) {
    return String(value ?? '')
        .replace(/\[\[AIWBR_MEMORY_VARS_BEGIN\]\][\s\S]*?\[\[AIWBR_MEMORY_VARS_END\]\]/gu, ' ')
        .replace(/<draft_notes>[\s\S]*?<\/draft_notes>/giu, ' ')
        .replace(/<ai_last_output>[\s\S]*?<\/ai_last_output>/giu, ' ')
        .replace(/<\/?peip>/giu, ' ')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function getMemoryRelevantMessages(chat, count) {
    return getRecentMessagesByCount(chat, count)
        .map(message => ({
            ...message,
            text: sanitizeMemoryMessageText(message.text),
        }))
        .filter(message => message.text);
}

function getAllMemoryMessages(chat) {
    return (Array.isArray(chat) ? chat : [])
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message && !message.is_system && message.mes)
        .map(({ message, index }) => ({
            index,
            floor: index + 1,
            messageId: String(message.id || message.messageId || message.extra?.id || message.send_date || ''),
            swipeId: String(message.swipe_id ?? message.swipeId ?? message.extra?.swipe_id ?? message.extra?.swipeId ?? ''),
            name: message.name || '',
            text: sanitizeMemoryMessageText(message.is_user ? extractActualUserInput(message.mes) : String(message.mes || '')),
            isUser: !!message.is_user,
        }))
        .filter(message => message.text);
}

function getHistoryImportRangeFromUi(context = getContext()) {
    const messages = getAllMemoryMessages(Array.isArray(context?.chat) ? context.chat : []);
    const maxFloor = messages.length ? Math.max(...messages.map(message => message.floor)) : 0;
    const startRaw = Number($('#ai_wbr_memory_history_start_floor').val());
    const endRaw = Number($('#ai_wbr_memory_history_end_floor').val());
    const startFloor = clampNumber(Number.isFinite(startRaw) ? startRaw : 1, 1, 1, Math.max(1, maxFloor));
    const endFloor = clampNumber(Number.isFinite(endRaw) ? endRaw : maxFloor, maxFloor, 1, Math.max(1, maxFloor));
    const first = Math.min(startFloor, endFloor);
    const last = Math.max(startFloor, endFloor);
    return {
        startFloor: first,
        endFloor: last,
        maxFloor,
        messages: messages.filter(message => message.floor >= first && message.floor <= last),
    };
}

function buildHistoryImportPreview(rangeInfo, context = getContext()) {
    const messages = Array.isArray(rangeInfo?.messages) ? rangeInfo.messages : [];
    const startFloor = Number(rangeInfo?.startFloor || 0);
    const endFloor = Number(rangeInfo?.endFloor || 0);
    const imported = !!rangeInfo?.imported;
    const floorLabel = startFloor && endFloor ? `${startFloor}-${endFloor}` : 'selected range';
    if (!messages.length) {
        return imported ? `Range ${floorLabel} has already been imported.` : `Range ${floorLabel} has no importable messages.`;
    }
    return `Selected ${floorLabel}; ${messages.length} message(s) can be imported${imported ? '; this range was imported before' : ''}.`;
}
function getHistoryImportSignature(messages, context = getContext()) {
    const chatKey = getCurrentChatMemoryKey(context);
    const sourceSignature = getMemorySourceSignature(messages);
    const firstFloor = messages[0]?.floor || 0;
    const lastFloor = messages[messages.length - 1]?.floor || 0;
    return `hist_${hashString(`${chatKey}|${firstFloor}|${lastFloor}|${messages.length}|${sourceSignature}`)}`;
}

function getHistoryImportRecord(signature, context = getContext()) {
    const container = getChatMemoryContainer(context);
    return (Array.isArray(container.historyImports) ? container.historyImports : [])
        .find(item => String(item.signature || '') === String(signature || ''));
}

function recordHistoryImport(signature, source, context = getContext()) {
    if (!signature) {
        return;
    }
    const container = getChatMemoryContainer(context);
    const records = Array.isArray(container.historyImports) ? container.historyImports : [];
    const nextRecord = {
        signature,
        source,
        createdAt: new Date().toISOString(),
    };
    container.historyImports = [
        nextRecord,
        ...records.filter(item => String(item.signature || '') !== signature),
    ].slice(0, 120);
    persistChatMemoryContainer(container, context);
}

function setHistoryImportRange(startFloor, endFloor, context = getContext()) {
    const messages = getAllMemoryMessages(Array.isArray(context?.chat) ? context.chat : []);
    const maxFloor = messages.length ? Math.max(...messages.map(message => message.floor)) : 0;
    if (!maxFloor) {
        $('#ai_wbr_memory_history_start_floor').val('');
        $('#ai_wbr_memory_history_end_floor').val('');
        buildHistoryImportPreview({ startFloor: 1, endFloor: 1, maxFloor: 0, messages: [] }, context);
        return;
    }
    const first = clampNumber(startFloor, 1, 1, maxFloor);
    const last = clampNumber(endFloor, maxFloor, 1, maxFloor);
    $('#ai_wbr_memory_history_start_floor').val(Math.min(first, last));
    $('#ai_wbr_memory_history_end_floor').val(Math.max(first, last));
    buildHistoryImportPreview(getHistoryImportRangeFromUi(context), context);
}

function getMemoryAutoRunMessageCount(context = getContext()) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    return chat.filter(message => message && !message.is_system && message.mes).length;
}

function getMemoryTurnSignature(recentMessages) {
    return recentMessages
        .slice(-4)
        .map(message => `${message.index ?? '?'}:${message.isUser ? 'U' : 'A'}:${message.name}:${message.messageId || ''}:${message.swipeId || ''}:${truncateText(message.text, 240)}`)
        .join('\n---\n');
}

function getMemorySourceSignature(recentMessages) {
    return recentMessages
        .slice(-4)
        .map(message => [
            message.index ?? '?',
            message.isUser ? 'U' : 'A',
            message.name || '',
            message.messageId || '',
            message.swipeId || '',
            hashString(message.text || ''),
        ].join(':'))
        .join('|');
}

function getMemorySourceSnapshot(context = getContext(), recentMessages = null, scanCount = settings.memoryRealtimeScanMessages || settings.memoryScanMessages) {
    const messages = Array.isArray(recentMessages)
        ? recentMessages
        : getMemoryRelevantMessages(Array.isArray(context?.chat) ? context.chat : [], scanCount);
    const last = messages[messages.length - 1] || {};
    const chatKey = getCurrentChatMemoryKey(context);
    const sourceSignature = getMemorySourceSignature(messages);
    const messageCount = getMemoryAutoRunMessageCount(context);
    return {
        id: `src_${hashString(`${chatKey}|${messageCount}|${sourceSignature}`)}`,
        chatKey,
        messageCount,
        indices: messages.map(message => message.index).filter(index => Number.isFinite(index)),
        lastIndex: Number.isFinite(last.index) ? last.index : -1,
        lastRole: last.isUser ? 'user' : 'assistant',
        lastName: String(last.name || ''),
        lastHash: hashString(last.text || ''),
        sourceSignature,
        createdAt: new Date().toISOString(),
    };
}

function getInvalidatedMemorySourceIds(chatKey = getCurrentChatMemoryKey()) {
    return Array.isArray(settings.memoryInvalidatedSourcesByChat?.[chatKey])
        ? settings.memoryInvalidatedSourcesByChat[chatKey].map(value => String(value))
        : [];
}

function setCurrentMemorySource(source, context = getContext()) {
    if (!source?.id) {
        return;
    }
    const chatKey = source.chatKey || getCurrentChatMemoryKey(context);
    settings.memoryLastSourceByChat[chatKey] = source;
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
}

function isMemorySourceCurrent(source, context = getContext()) {
    if (!source?.id) {
        return true;
    }
    const chatKey = getCurrentChatMemoryKey(context);
    if (source.chatKey && source.chatKey !== chatKey) {
        return false;
    }
    if (getInvalidatedMemorySourceIds(chatKey).includes(String(source.id))) {
        return false;
    }
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    if (source.mode === 'history') {
        const startFloor = Number(source.rangeStartFloor || 0);
        const endFloor = Number(source.rangeEndFloor || 0);
        if (!startFloor || !endFloor) {
            return true;
        }
        const currentMessages = getAllMemoryMessages(chat)
            .filter(message => message.floor >= Math.min(startFloor, endFloor) && message.floor <= Math.max(startFloor, endFloor));
        const last = currentMessages[currentMessages.length - 1] || {};
        return currentMessages.length === Number(source.scanMessages || 0)
            && getMemorySourceSignature(currentMessages) === String(source.sourceSignature || '')
            && Number(last.index ?? -1) === Number(source.lastIndex ?? -1)
            && hashString(last.text || '') === String(source.lastHash || '');
    }
    const scanCount = clampNumber(source.scanMessages, settings.memoryRealtimeScanMessages || settings.memoryScanMessages, 2, 40);
    const currentMessages = getMemoryRelevantMessages(chat, scanCount);
    const current = getMemorySourceSnapshot(context, currentMessages);
    return current.messageCount === Number(source.messageCount || 0)
        && current.sourceSignature === String(source.sourceSignature || '')
        && current.lastIndex === Number(source.lastIndex ?? -1)
        && current.lastHash === String(source.lastHash || '');
}

function getMemorySourceLabel(source) {
    if (!source) {
        return '';
    }
    const indices = Array.isArray(source.indices) ? source.indices : [];
    if (!indices.length) {
        return '';
    }
    const floors = indices.map(index => Number(index) + 1).filter(index => Number.isFinite(index));
    if (!floors.length) {
        return '';
    }
    const first = floors[0];
    const last = floors[floors.length - 1];
    return first === last ? `Floor ${first}` : `Floor ${first}-${last}`;
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
    const customStateLines = getCustomMemoryStateDefinitions(graph)
        .map(definition => {
            const value = String(state.custom_values?.[definition.key] || '').trim();
            return value ? `${definition.label}：${value}` : '';
        })
        .filter(Boolean)
        .join('\n');

    const parts = [
        '[轻量记忆状态]',
        state.current_location ? `当前地点：${state.current_location}` : '',
        state.current_objective ? `当前目标：${state.current_objective}` : '',
        state.active_topics?.length ? `活跃主题：${state.active_topics.join('、')}` : '',
        state.open_questions?.length ? `未解问题：${state.open_questions.join('、')}` : '',
        customStateLines,
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
    const chatText = recentMessages
        .map(message => `${message.isUser ? 'User' : 'Assistant'} #${message.floor}: ${sanitizeMemoryMessageText(message.text)}`)
        .join('\n\n');
    const currentGraph = truncateText(JSON.stringify({
        state: graph.state,
        stateDefinitions: getCustomMemoryStateDefinitions(graph),
        nodes: graph.nodes.slice(-8).map(node => ({ id: node.id, title: node.title, type: node.type })),
        links: graph.links.slice(-12).map(link => ({ source: link.source, target: link.target, type: link.type })),
    }, null, 2), 4200);
    const customDefinitions = getCustomMemoryStateDefinitions(graph);
    const customDefinitionLines = customDefinitions.length
        ? customDefinitions.map(definition => `- ${definition.label} (${definition.key}): ${definition.instruction || 'Custom state field'}`).join('\n')
        : '- None';

    return `<role>You are a SillyTavern lightweight memory extractor.</role>
<task>Extract only durable facts that will matter for future roleplay. Return only the variable block below.</task>
<rules>
1. Do not return JSON outside the requested variables.
2. Do not explain your reasoning.
3. Keep node ids stable and snake_case.
4. Prefer updating existing nodes over duplicating them.
5. If there is no useful memory, return empty arrays and preserve state fields as empty strings or arrays.
</rules>
<custom_state_definitions>
${customDefinitionLines}
</custom_state_definitions>
<current_memory_graph>
${currentGraph}
</current_memory_graph>
<recent_messages>
${truncateText(chatText, 9000)}
</recent_messages>
<output_format>
[[AIWBR_MEMORY_VARS_BEGIN]]
memory_state_current_location_json=""
memory_state_current_time_json=""
memory_state_protagonist_status_json=""
memory_state_current_objective_json=""
memory_state_current_phase_json=""
memory_active_topics_json=[]
memory_open_questions_json=[]
memory_custom_state_json={}
memory_nodes_json=[]
memory_updates_json=[]
memory_links_json=[]
memory_remove_node_ids_json=[]
memory_last_summary_json=""
[[AIWBR_MEMORY_VARS_END]]
</output_format>`;
}
function buildMemoryExtractionRetryPrompt(recentMessages, graph) {
    const basePrompt = buildMemoryExtractionPrompt(recentMessages, graph);
    return `${basePrompt}

<retry_instruction>
Your previous response could not be parsed. Return only the exact AIWBR variable block. Do not include markdown, prose, comments, or JSON wrappers.
</retry_instruction>`;
}
function getRouterRequestMaxTokens() {
    return clampNumber(settings.routerRequestMaxTokens, defaultSettings.routerRequestMaxTokens, 32, 100000);
}

function getMemoryRequestMaxTokens() {
    return clampNumber(settings.memoryRequestMaxTokens, defaultSettings.memoryRequestMaxTokens, 32, 100000);
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
                current_time: readJsonValue('memory_state_current_time_json', ''),
                protagonist_status: readJsonValue('memory_state_protagonist_status_json', ''),
                current_objective: readJsonValue('memory_state_current_objective_json', ''),
                current_phase: readJsonValue('memory_state_current_phase_json', ''),
                active_topics: readJsonValue('memory_active_topics_json', []),
                open_questions: readJsonValue('memory_open_questions_json', []),
                custom_state: readJsonValue('memory_custom_state_json', {}),
            },
            nodes: readJsonValue('memory_nodes_json', []),
            updates: readJsonValue('memory_updates_json', []),
            links: readJsonValue('memory_links_json', []),
            remove_node_ids: readJsonValue('memory_remove_node_ids_json', []),
            remove_link_ids: readJsonValue('memory_remove_link_ids_json', []),
            summary: readJsonValue('memory_summary_json', readJsonValue('memory_last_summary_json', '')),
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

function applyMemoryGraphUpdate(update, context = getContext()) {
    update = sanitizeMemoryUpdateForApply(update);
    const graph = getMemoryGraph(context);
    const now = new Date().toISOString();
    let addedOrUpdatedNodeCount = 0;
    const touchedEntries = [];

    const state = update?.state && typeof update.state === 'object' ? update.state : {};
    if (typeof state.current_location === 'string') {
        graph.state.current_location = truncateText(state.current_location, 120);
    }
    if (typeof state.current_time === 'string') {
        graph.state.current_time = truncateText(state.current_time, 120);
    }
    if (typeof state.protagonist_status === 'string') {
        graph.state.protagonist_status = truncateText(state.protagonist_status, 180);
    }
    if (typeof state.current_objective === 'string') {
        graph.state.current_objective = truncateText(state.current_objective, 180);
    }
    if (typeof state.current_phase === 'string') {
        graph.state.current_phase = truncateText(state.current_phase, 120);
    }
    if (Array.isArray(state.active_topics)) {
        graph.state.active_topics = uniqueStrings([...state.active_topics]).slice(0, 12);
    }
    if (Array.isArray(state.open_questions)) {
        graph.state.open_questions = uniqueStrings([...state.open_questions]).slice(0, 12);
    }
    if (state.custom_state && typeof state.custom_state === 'object' && !Array.isArray(state.custom_state)) {
        const allowedKeys = new Set(getCustomMemoryStateDefinitions(graph).map(definition => definition.key));
        graph.state.custom_values = graph.state.custom_values && typeof graph.state.custom_values === 'object'
            ? graph.state.custom_values
            : {};
        for (const [key, rawValue] of Object.entries(state.custom_state)) {
            if (!allowedKeys.has(key)) {
                continue;
            }
            graph.state.custom_values[key] = truncateText(String(rawValue || '').trim(), 220);
        }
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
        if (!isValidMemoryNodeForApply(node)) {
            continue;
        }
        const existing = byId.get(node.id) || graph.nodes.find(item => normalizeText(item.title) === normalizeText(node.title));
        if (existing) {
            Object.assign(existing, {
                ...existing,
                title: node.title || existing.title,
                type: node.type || existing.type,
                content: node.content || existing.content,
                summary: node.summary || existing.summary,
                location: node.location || existing.location,
                timeSpan: node.timeSpan || existing.timeSpan,
                keys: uniqueStrings([...(existing.keys || []), ...(node.keys || [])]),
                tags: uniqueStrings([...(existing.tags || []), ...(node.tags || [])]),
                importance: Math.max(Number(existing.importance || 0), Number(node.importance || 0)),
                credibility: Math.max(Number(existing.credibility || 0), Number(node.credibility || 0)),
                updatedAt: now,
            });
            byId.set(existing.id, existing);
            addedOrUpdatedNodeCount += 1;
            touchedEntries.push(existing);
        } else {
            graph.nodes.push(node);
            byId.set(node.id, node);
            addedOrUpdatedNodeCount += 1;
            touchedEntries.push(node);
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
        if (rawUpdate.summary) {
            existing.summary = truncateText(rawUpdate.summary, 120);
        }
        if (rawUpdate.location) {
            existing.location = truncateText(rawUpdate.location, 120);
        }
        if (rawUpdate.timeSpan || rawUpdate.time_span) {
            existing.timeSpan = truncateText(rawUpdate.timeSpan || rawUpdate.time_span, 120);
        }
        if (rawUpdate.keys) {
            existing.keys = uniqueStrings([...(existing.keys || []), ...(Array.isArray(rawUpdate.keys) ? rawUpdate.keys : String(rawUpdate.keys).split(/[,\n;]+/u))]);
        }
        if (rawUpdate.importance !== undefined) {
            existing.importance = clampNumber(rawUpdate.importance, existing.importance || 0.6, 0, 1);
        }
        if (rawUpdate.credibility !== undefined) {
            existing.credibility = clampNumber(rawUpdate.credibility, existing.credibility || 0.8, 0, 1);
        }
        existing.updatedAt = now;
        addedOrUpdatedNodeCount += 1;
        touchedEntries.push(existing);
    }

    if (!addedOrUpdatedNodeCount) {
        const fallbackNode = createMemoryFallbackNodeFromSummary(update?.summary, byId.size);
        if (fallbackNode) {
            graph.nodes.push(fallbackNode);
            byId.set(fallbackNode.id, fallbackNode);
            addedOrUpdatedNodeCount += 1;
            touchedEntries.push(fallbackNode);
        }
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
    saveMemoryGraph(graph, context);
    return {
        graph,
        touchedEntries: uniqueStrings(touchedEntries.map(entry => entry?.id))
            .map(id => graph.nodes.find(node => node.id === id))
            .filter(Boolean),
    };
}

function stopMemoryAnimation(success = true) {
    const underline = $('#ai_wbr_fx_layer .ai-wbr-book-underline');
    if (!underline.length) {
        return;
    }
    if (success) {
        setTimeout(() => underline.remove(), 120);
    } else {
        underline.addClass('ai-wbr-book-underline-error');
        setTimeout(() => underline.remove(), 980);
    }
}

async function runHistoryMemoryImport() {
    if (!settings.memoryEnabled || isMemoryWorkerRunning || isRouterSelectionRequest) {
        toastr?.warning?.('Please try again later.', 'AI Worldbook Router');
        return false;
    }

    const context = getContext();
    const memoryRunChatKey = getCurrentChatMemoryKey(context);
    const rangeInfo = getHistoryImportRangeFromUi(context);
    const recentMessages = rangeInfo.messages;
    buildHistoryImportPreview(rangeInfo, context);

    if (recentMessages.length < 2) {
        setMemoryStatus('历史补录失败：所选楼层不足 2 条可整理消息', context);
        toastr?.warning?.('Please try again later.', 'AI Worldbook Router');
        return false;
    }

    const mode = String($('#ai_wbr_memory_history_mode').val() || settings.memoryHistoryMode || 'history');
    saveSetting('memoryHistoryMode', mode);
    const skipDone = !!$('#ai_wbr_memory_history_skip_done').prop('checked');
    saveSetting('memoryHistorySkipDone', skipDone);

    const signature = getHistoryImportSignature(recentMessages, context);
    const existingRecord = getHistoryImportRecord(signature, context);
    if (skipDone && existingRecord) {
            setMemoryStatus('Importing history memory...', context);
        toastr?.info?.('Done.', 'AI Worldbook Router');
        return false;
    }

    const source = {
        ...getMemorySourceSnapshot(context, recentMessages, recentMessages.length),
        id: signature,
        mode: 'history',
        importMode: mode,
        scanMessages: recentMessages.length,
        rangeStartFloor: rangeInfo.startFloor,
        rangeEndFloor: rangeInfo.endFloor,
        indices: recentMessages.map(message => message.index).filter(index => Number.isFinite(index)),
    };

    isMemoryWorkerRunning = true;
    startMemoryAnimation();
            setMemoryStatus('Importing history memory...', context);

    try {
        const graph = getMemoryGraph(context);
        const prompt = buildMemoryExtractionPrompt(recentMessages, graph)
            + `\n\n<history_import_mode>${mode === 'summary' ? 'Summary mode: compress this range into durable plot, relationship, and open-question notes.' : 'History mode: extract reusable facts, relationships, settings, promises, and key events.'}</history_import_mode>`
            + `\n<history_import_range>Floors ${rangeInfo.startFloor}-${rangeInfo.endFloor}; ${recentMessages.length} valid messages.</history_import_range>`;
        const maxAttempts = Math.max(1, Number(settings.memoryRetries || 0) + 1);
        const baseSystemPrompt = 'Return only the requested AIWBR variable block. Do not explain, reason, use markdown, or wrap in JSON.';
        const retrySystemPrompt = 'Your previous response was invalid. Return only the AIWBR variable block, with no prose or markdown.';
        let raw = '';
        let lastError = null;
        setCurrentMemoryLastRaw('', context);
        setCurrentMemoryLastError('', context);

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const useRetryPrompt = attempt > 1;
            const activePrompt = useRetryPrompt ? buildMemoryExtractionRetryPrompt(recentMessages, graph) : prompt;
            const activeSystemPrompt = useRetryPrompt ? retrySystemPrompt : baseSystemPrompt;
            const promptLog = useRetryPrompt
                ? `${prompt}\n\n----- HISTORY RETRY #${attempt - 1} PROMPT -----\n\n${activePrompt}`
                : prompt;
            setCurrentMemoryLastPrompt(promptLog, context);

            try {
                isRouterSelectionRequest = true;
                raw = await requestMemoryExtraction(context, activePrompt, activeSystemPrompt);
            } catch (error) {
                lastError = error;
                if (isGatewayLikeError(error) || attempt >= maxAttempts) {
                    throw error;
                }
                playStatusBurst('retry', 'retry');
                continue;
            } finally {
                isRouterSelectionRequest = false;
            }

            setCurrentMemoryLastRaw(summarizeRouterResponse(raw), context);

            if (hasEmptyVisibleContentDueToLength(raw)) {
                lastError = new Error('Memory extraction returned empty visible content due to length.');
                if (attempt >= maxAttempts) {
                    throw lastError;
                }
                playStatusBurst('retry', 'retry');
                continue;
            }

            try {
                let update = parseMemoryUpdate(raw, promptLog);
                update = ensureMemoryUpdateHasVisibleFallback(update, recentMessages, mode);
                setCurrentMemoryLastError('', context);
                if (getCurrentChatMemoryKey() !== memoryRunChatKey) {
                    debugLog('Discarded history memory import because chat changed before completion', {
                        started: memoryRunChatKey,
                        current: getCurrentChatMemoryKey(),
                    });
                    return false;
                }

                const container = getChatMemoryContainer(context);
                container.graphBackup = cloneMemoryGraph(graph);
                persistChatMemoryContainer(container, context);

                if (settings.memoryReviewRequired) {
                    const review = enqueueMemoryReview(update, {
                        reason: 'history_import',
                        signature,
                        source,
                        prompt: promptLog,
                        raw: summarizeRouterResponse(raw),
                    }, context);
                    recordHistoryImport(signature, source, context);
                    setCurrentMemorySource(source, context);
            setMemoryStatus('Importing history memory...', context);
                    playStatusBurst('ok', 'memory');
                    toastr?.info?.('Done.', 'AI Worldbook Router');
                    stopMemoryAnimation(true);
                    return true;
                }

                const memoryResult = applyMemoryGraphUpdate(update, context);
                recordHistoryImport(signature, source, context);
                setCurrentMemorySource(source, context);
            setMemoryStatus('Importing history memory...', context);
                if (memoryResult.touchedEntries.length) {
                    playEntryBurst(memoryResult.touchedEntries, {
                        variant: 'memory',
                        labelGetter: getMemoryBurstLabel,
                    });
                } else {
                    playStatusBurst('ok', 'memory');
                }
                stopMemoryAnimation(true);
                return true;
            } catch (error) {
                lastError = error;
                setCurrentMemoryLastError(error?.message || String(error), context);
                if (attempt >= maxAttempts) {
                    throw error;
                }
                playStatusBurst('retry', 'retry');
            }
        }

        throw lastError || new Error('History memory import failed.');
    } catch (error) {
        console.warn(`${LOG_PREFIX} History memory import failed`, error);
        setCurrentMemoryLastError(error?.message || String(error), context);
        if (error?.routerRaw && !getCurrentMemoryLastRaw(context)) {
            setCurrentMemoryLastRaw(error.routerRaw, context);
        }
        if (error?.routerPrompt && !getCurrentMemoryLastPrompt(context)) {
            setCurrentMemoryLastPrompt(error.routerPrompt, context);
        }
            setMemoryStatus('Importing history memory...', context);
        playStatusBurst('fail', 'fail');
        stopMemoryAnimation(false);
        return false;
    } finally {
        isMemoryWorkerRunning = false;
        buildHistoryImportPreview(getHistoryImportRangeFromUi(context), context);
        renderMemoryPanel();
    }
}

async function runMemoryGraphUpdate(reason = 'realtime', options = {}) {
    if (!settings.memoryEnabled) {
        setMemoryStatus('实时整理未运行：记忆功能未启用。');
        return false;
    }
    if (isMemoryWorkerRunning) {
        const busyMs = Date.now() - Number(memoryWorkerStartedAt || 0);
        if (!options.force || busyMs < 120000) {
            setMemoryStatus('实时整理跳过：上一轮记忆整理仍在运行。');
            return false;
        }
        console.warn(`${LOG_PREFIX} Reset stale memory worker lock`, { busyMs });
        isMemoryWorkerRunning = false;
        memoryWorkerStartedAt = 0;
    }
    if (isRouterSelectionRequest && !options.force) {
        setMemoryStatus('实时整理跳过：路由请求正在使用模型。');
        return false;
    }

    const context = getContext();
    const memoryRunChatKey = getCurrentChatMemoryKey(context);
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const mode = options.mode || (reason === 'summary' || reason === 'manual_summary' ? 'summary' : 'realtime');
    const scanMessages = clampNumber(
        options.scanMessages ?? (mode === 'summary' ? settings.memorySummaryScanMessages : settings.memoryRealtimeScanMessages),
        mode === 'summary' ? defaultSettings.memorySummaryScanMessages : defaultSettings.memoryRealtimeScanMessages,
        2,
        40,
    );
    const recentMessages = getMemoryRelevantMessages(chat, scanMessages);
    if (recentMessages.length < 2) {
        setMemoryStatus('实时整理跳过：可整理消息不足 2 条。');
        return false;
    }

    const signature = getMemoryTurnSignature(recentMessages);
    const source = {
        ...getMemorySourceSnapshot(context, recentMessages, scanMessages),
        mode,
        scanMessages,
    };
    if (mode === 'realtime' && reason !== 'manual' && !options.force && signature && signature === getCurrentMemoryLastTurnSignature(context)) {
        setMemoryStatus('实时整理跳过：当前聊天图谱已是最新。');
        return false;
    }

    isMemoryWorkerRunning = true;
    memoryWorkerStartedAt = Date.now();
    startMemoryAnimation();
    setMemoryStatus(mode === 'summary' ? '间隔归纳整理中...' : '实时记忆整理中...');

    try {
        const graph = getMemoryGraph();
        const prompt = buildMemoryExtractionPrompt(recentMessages, graph);
        setCurrentMemoryLastRaw('', context);
        setCurrentMemoryLastError('', context);
        const maxAttempts = Math.max(1, Number(settings.memoryRetries || 0) + 1);
        const baseSystemPrompt = 'Return only the requested AIWBR variable block. Do not explain, reason, use markdown, or wrap in JSON.';
        const retrySystemPrompt = 'Your previous response was invalid. Return only the AIWBR variable block, with no prose or markdown.';
        let raw = '';
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const useRetryPrompt = attempt > 1;
            const activePrompt = useRetryPrompt ? buildMemoryExtractionRetryPrompt(recentMessages, graph) : prompt;
            const activeSystemPrompt = useRetryPrompt ? retrySystemPrompt : baseSystemPrompt;
            const promptLog = useRetryPrompt
                ? `${prompt}\n\n----- RETRY #${attempt - 1} PROMPT -----\n\n${activePrompt}`
                : prompt;
            setCurrentMemoryLastPrompt(promptLog, context);

            try {
                isRouterSelectionRequest = true;
                raw = await requestMemoryExtraction(context, activePrompt, activeSystemPrompt);
            } catch (error) {
                lastError = error;
                if (isGatewayLikeError(error) || attempt >= maxAttempts) {
                    throw error;
                }
                playStatusBurst('retry', 'retry');
                continue;
            } finally {
                isRouterSelectionRequest = false;
            }

            setCurrentMemoryLastRaw(summarizeRouterResponse(raw), context);

            if (hasEmptyVisibleContentDueToLength(raw)) {
                lastError = new Error('Memory extraction returned empty visible content due to length.');
                if (attempt >= maxAttempts) {
                    throw lastError;
                }
                playStatusBurst('retry', 'retry');
                continue;
            }

            try {
                let update = parseMemoryUpdate(raw, promptLog);
                update = ensureMemoryUpdateHasVisibleFallback(update, recentMessages, mode);
                setCurrentMemoryLastError('', context);
                if (getCurrentChatMemoryKey() !== memoryRunChatKey) {
                    debugLog('Discarded memory update because chat changed before completion', {
                        started: memoryRunChatKey,
                        current: getCurrentChatMemoryKey(),
                    });
                    return false;
                }
                if (!isMemorySourceCurrent(source, context)) {
                    debugLog('Discarded memory update because source floor changed before completion', {
                        source,
                        current: getMemorySourceSnapshot(context, null, scanMessages),
                    });
                    setCurrentMemoryLastTurnSignature('', context);
            setMemoryStatus('Importing history memory...', context);
                    stopMemoryAnimation(false);
                    return false;
                }
                
                // Backup graph before applying update
                const container = getChatMemoryContainer(context);
                container.graphBackup = cloneMemoryGraph(graph);
                persistChatMemoryContainer(container, context);
                
                let memoryResult = null;
                const shouldQueueReview = !!settings.memoryReviewRequired && options.review === true;
                if (shouldQueueReview) {
                    const review = enqueueMemoryReview(update, {
                        reason,
                        signature,
                        source,
                        prompt: promptLog,
                        raw: summarizeRouterResponse(raw),
                    }, context);
                    setCurrentMemorySource(source, context);
                    setCurrentMemoryLastTurnSignature(signature, context);
                    const updatedContainer = getChatMemoryContainer(context);
                    const messageCount = getMemoryAutoRunMessageCount(context);
                    if (mode === 'summary') {
                        updatedContainer.lastSummaryMessageCount = messageCount;
                    } else {
                        updatedContainer.lastAutoMessageCount = messageCount;
                    }
                    persistChatMemoryContainer(updatedContainer, context);
                    setMemoryStatus(`已生成待确认记忆更新：${getMemoryReviewQueue(context).length} 条。确认后才会写入图谱。`, context);
                    playStatusBurst('ok', 'memory');
                    toastr?.info?.('Done.', 'AI Worldbook Router');
                    stopMemoryAnimation(true);
                    return true;
                }

                memoryResult = applyMemoryGraphUpdate(update, context);
                setCurrentMemorySource(source, context);
                setCurrentMemoryLastTurnSignature(signature, context);
                const updatedContainer = getChatMemoryContainer(context);
                const messageCount = getMemoryAutoRunMessageCount(context);
                if (mode === 'summary') {
                    updatedContainer.lastSummaryMessageCount = messageCount;
                } else {
                    updatedContainer.lastAutoMessageCount = messageCount;
                }
                persistChatMemoryContainer(updatedContainer, context);
                const nodeCount = memoryResult.graph.nodes.length;
                const linkCount = memoryResult.graph.links.length;
                setMemoryStatus(`记忆图谱已更新：${nodeCount} 个节点，${linkCount} 条关系。`, context);
                if (memoryResult.touchedEntries.length) {
                    playEntryBurst(memoryResult.touchedEntries, {
                        variant: 'memory',
                        labelGetter: getMemoryBurstLabel,
                    });
                } else {
                    playStatusBurst('ok', 'memory');
                }
                stopMemoryAnimation(true);
                return true;
            } catch (error) {
                lastError = error;
                setCurrentMemoryLastError(error?.message || String(error), context);
                if (attempt >= maxAttempts) {
                    throw error;
                }
                playStatusBurst('retry', 'retry');
            }
        }

        throw lastError || new Error('Memory extraction failed.');
    } catch (error) {
        console.warn(`${LOG_PREFIX} Memory graph update failed`, error);
        setCurrentMemoryLastError(error?.message || String(error), context);
        if (error?.routerRaw && !getCurrentMemoryLastRaw(context)) {
            setCurrentMemoryLastRaw(error.routerRaw, context);
        }
        if (error?.routerPrompt && !getCurrentMemoryLastPrompt(context)) {
            setCurrentMemoryLastPrompt(error.routerPrompt, context);
        }
        setMemoryStatus(`记忆失败：${truncateText(error?.message || error, 80)}`);
        playStatusBurst('fail', 'fail');
        stopMemoryAnimation(false);
        return false;
    } finally {
        isMemoryWorkerRunning = false;
        memoryWorkerStartedAt = 0;
        renderMemoryPanel();
    }
}

function scheduleMemoryGraphUpdate() {
    if (!settings.memoryEnabled) {
        setMemoryStatus('实时整理未运行：记忆功能未启用。');
        return;
    }

    const context = getContext();
    const currentCount = getMemoryAutoRunMessageCount(context);
    const container = getChatMemoryContainer(context);
    const shouldRunRealtime = !!settings.memoryRealtimeEnabled;
    const summaryInterval = clampNumber(settings.memorySummaryIntervalMessages, defaultSettings.memorySummaryIntervalMessages, 1, 100);
    const lastSummaryCount = clampNumber(container.lastSummaryMessageCount || container.lastAutoMessageCount, 0, 0, 1000000);
    const shouldRunSummary = !!settings.memorySummaryEnabled && currentCount - lastSummaryCount >= summaryInterval;

    if (!shouldRunRealtime && !shouldRunSummary) {
        debugLog('Memory update skipped', { currentCount, lastSummaryCount, summaryInterval });
        setMemoryStatus(`实时整理跳过：实时整理关闭，或摘要还差 ${Math.max(0, summaryInterval - (currentCount - lastSummaryCount))} 条消息。`);
        return;
    }

    clearTimeout(memoryUpdateTimer);
    memoryUpdateTimer = setTimeout(async () => {
        if (shouldRunRealtime) {
            const forceRealtime = String(getCurrentMemoryLastTurnSignature(context) || '') === '';
            await runMemoryGraphUpdate('realtime', {
                mode: 'realtime',
                scanMessages: settings.memoryRealtimeScanMessages,
                force: forceRealtime,
            });
        }
        if (shouldRunSummary) {
            if (shouldRunRealtime) {
                await new Promise(resolve => setTimeout(resolve, 650));
            }
            await runMemoryGraphUpdate('summary', {
                mode: 'summary',
                scanMessages: settings.memorySummaryScanMessages,
            });
        }
    }, 900);
}

async function preRefreshMemoryForRoute(context = getContext()) {
    const startedAt = Date.now();
    const result = {
        attempted: false,
        completed: false,
        timedOut: false,
        updated: false,
        skippedReason: '',
        durationMs: 0,
    };

    if (!settings.memoryEnabled) {
        result.skippedReason = 'memory-disabled';
        return result;
    }
    if (!settings.memoryRealtimeEnabled) {
        result.skippedReason = 'realtime-disabled';
        return result;
    }
    if (isMemoryWorkerRunning || isRouterSelectionRequest) {
        result.skippedReason = 'memory-busy';
        return result;
    }

    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const scanMessages = clampNumber(settings.memoryRealtimeScanMessages, defaultSettings.memoryRealtimeScanMessages, 2, 40);
    const recentMessages = getMemoryRelevantMessages(chat, scanMessages);
    if (recentMessages.length < 2) {
        result.skippedReason = 'not-enough-messages';
        return result;
    }

    const signature = getMemoryTurnSignature(recentMessages);
    if (signature && signature === getCurrentMemoryLastTurnSignature(context)) {
        result.skippedReason = 'already-current';
        return result;
    }

    result.attempted = true;
    const updatePromise = runMemoryGraphUpdate('pre_route', {
        mode: 'realtime',
        scanMessages,
    })
        .then(updated => {
            result.completed = true;
            result.updated = !!updated;
            return result;
        })
        .catch(error => {
            result.completed = true;
            result.skippedReason = error?.message || String(error);
            console.warn(`${LOG_PREFIX} Pre-route memory refresh failed.`, error);
            return result;
        });

    const timeoutMs = 1800;
    const timeoutPromise = new Promise(resolve => {
        setTimeout(() => {
            result.timedOut = true;
            result.skippedReason = 'timeout';
            resolve(result);
        }, timeoutMs);
    });

    const settled = await Promise.race([updatePromise, timeoutPromise]);
    updatePromise.finally(() => renderDebugPanel()).catch(() => {});
    settled.durationMs = Date.now() - startedAt;
    return settled;
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

    const worldName = book.name || character?.name || 'embedded';
    if (!getWorldSelectionState(worldName)) {
        return [];
    }

    const converted = convertCharacterBook(book);
    return worldEntriesFromData(converted, 'character_book', worldName);
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
        if (!getWorldSelectionState(worldName)) {
            debugLog('Skipped unselected worldbook', { worldName, source });
            continue;
        }
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

function buildAiPrompt(recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
    const lastUserMessage = getLastUserMessage(recentMessages);
    const recentContext = recentMessages
        .map(message => `${message.name || (message.isUser ? 'User' : 'Assistant')}: ${truncateText(message.text, MAX_ROUTER_CONTEXT_PREVIEW)}`)
        .join('\n\n');
    const candidateText = candidates.map(entry => {
        const keys = entry.keys.all.length ? entry.keys.all.join(' / ') : '(无 keys)';
        return `- ${keys}`;
    }).join('\n');

    return `<task>
从候选 keys 中选择最多 ${maxSelectCount} 条“本轮真正相关”的条目（世界书、动态记忆或资料片段）。
</task>

<rules>
1. 只能从候选 keys 中选。
2. 只输出严格 JSON。
3. 禁止 Markdown、禁止解释、禁止 reasoning、禁止额外字段。
4. 不要返回标题，不要返回 id，只返回命中的 key。
5. 如果没有合适条目，输出 {"selected":[]}。
</rules>

<output_format>
{"selected":[{"key":"命中的 key","reason":"简短原因"}]}
</output_format>

<example>
输入：
最后用户消息：我想偷偷补完魔法阵然后逃跑
候选 keys：
- 魔法 / 魔法阵 / 画魔法
- 奇夫利 / 老师
- 魔法商品 / 魔法器
输出：
{"selected":[{"key":"魔法阵","reason":"用户正在补画魔法阵"},{"key":"奇夫利","reason":"当前互动对象是奇夫利"}]}
</example>

<last_user_message>
${lastUserMessage || '(空)'}
</last_user_message>

<recent_context>
${recentContext || '(空)'}
</recent_context>

<state_summary>
${mvuSummary || '(未启用或未读取到)'}
</state_summary>

<candidate_keys>
${candidateText || '(无)'}
</candidate_keys>`;
}

function buildCompactAiPrompt(recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
    const lastUserMessage = truncateText(getLastUserMessage(recentMessages), 220);
    const compactContext = recentMessages
        .slice(-4)
        .map(message => `${message.name || (message.isUser ? 'User' : 'Assistant')}: ${truncateText(message.text, 180)}`)
        .join('\n');
    const compactSummary = truncateText(String(mvuSummary || ''), 320);
    const candidateText = candidates
        .slice(0, Math.min(candidates.length, 14))
        .map(entry => `- ${(entry.keys.all.length ? entry.keys.all.join(' / ') : '(无 keys)')}`)
        .join('\n');

    return `<task>从候选 keys 中选择最多 ${maxSelectCount} 条本轮相关条目（世界书、动态记忆或资料片段）。</task>
<rules>只输出严格 JSON；禁止解释；禁止 reasoning；禁止额外字段；如果没有合适条目，输出 {"selected":[]}。</rules>
<output>{"selected":[{"key":"命中的 key","reason":"简短原因"}]}</output>
<last_user_message>${lastUserMessage || '(空)'}</last_user_message>
<recent_context>${compactContext || '(空)'}</recent_context>
<state_summary>${compactSummary || '(无)'}</state_summary>
<candidate_keys>
${candidateText || '(无)'}
</candidate_keys>`;
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

    const texts = collectRouterResponseTexts(rawResponse)
        .map(text => stripReasoningForDisplay(text))
        .filter(text => String(text || '').trim());
    if (texts.length) {
        return texts.join('\n\n---\n\n');
    }

    try {
        return stripReasoningForDisplay(JSON.stringify(rawResponse, null, 2));
    } catch {
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
        'just a natural event', 'not what happens after', 'not about', 'irrelevant', 'not an answer',
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

function hasEmptyVisibleContentDueToLength(rawResponse) {
    const choice = rawResponse?.choices?.[0];
    return !!choice
        && choice?.finish_reason === 'length'
        && typeof choice?.message?.content === 'string'
        && !choice.message.content.trim();
}

function isGatewayLikeError(error) {
    if (error?.isGatewayError) {
        return true;
    }
    const text = `${error?.message || ''}\n${String(error || '')}`.toLowerCase();
    return /\b(502|503|504)\b/u.test(text)
        || text.includes('gateway time-out')
        || text.includes('gateway timeout')
        || text.includes('endpoint failed');
}

function buildPlainSeparateChatPayload(prompt, {
    systemPrompt = settings.systemPrompt,
    maxTokens = getRouterRequestMaxTokens(),
} = {}) {
    return {
        stream: false,
        messages: getRouterMessages(prompt, systemPrompt),
        model: settings.routerModel,
        chat_completion_source: 'openai',
        max_tokens: maxTokens,
        temperature: 0,
        reverse_proxy: normalizeUrl(settings.routerApiUrl),
        proxy_password: String(settings.routerApiKey || ''),
    };
}

async function sendPlainSeparateChatRequest(context, payload) {
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {}),
        },
        cache: 'no-cache',
        body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
        let errorMessage = text;
        try {
            const parsed = JSON.parse(text);
            errorMessage = parsed?.error?.message || parsed?.message || text;
        } catch {
            errorMessage = text.slice(0, 180);
        }
        const error = new Error(`Endpoint failed (${response.status}): ${errorMessage}`);
        error.status = response.status;
        error.isGatewayError = [502, 503, 504].includes(response.status);
        throw error;
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function sendSeparateRouterRequest(context, prompt, {
    recentMessages = [],
    mvuSummary = '',
    candidates = [],
    systemPrompt = settings.systemPrompt,
    maxTokens = getRouterRequestMaxTokens(),
    maxSelectCount = settings.maxSelected,
} = {}) {
    const firstRequest = buildPlainSeparateChatPayload(prompt, {
        systemPrompt,
        maxTokens,
    });
    let raw = await sendPlainSeparateChatRequest(context, firstRequest);
    if (!isEffectivelyEmptyStructuredResponse(raw) && !hasEmptyVisibleContentDueToLength(raw)) {
        return { raw, usedRetry: false, usedCompactPrompt: false };
    }

    const compactPrompt = buildCompactAiPrompt(
        recentMessages,
        mvuSummary,
        candidates,
        maxSelectCount
    );
    const retryRequest = buildPlainSeparateChatPayload(compactPrompt, {
        systemPrompt: 'Return strict JSON only: {"selected":[]}. Do not explain or include reasoning.',
        maxTokens: getRouterRequestMaxTokens(),
    });
    raw = await sendPlainSeparateChatRequest(context, retryRequest);
    return { raw, usedRetry: true, usedCompactPrompt: true, retryPrompt: compactPrompt };
}

async function sendSeparateMemoryRequest(context, prompt, {
    systemPrompt,
    maxTokens = getMemoryRequestMaxTokens(),
} = {}) {
    const requestData = buildPlainSeparateChatPayload(prompt, {
        systemPrompt,
        maxTokens,
    });
    return await sendPlainSeparateChatRequest(context, requestData);
}

function getRouterRequestData(context, prompt) {
    return buildPlainSeparateChatPayload(prompt, {
        systemPrompt: settings.systemPrompt,
        maxTokens: getRouterRequestMaxTokens(),
    });
}

async function selectWithSeparateRouterModel(context, recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
    const prompt = buildAiPrompt(recentMessages, mvuSummary, candidates, maxSelectCount);
    const result = await sendSeparateRouterRequest(context, prompt, {
        recentMessages,
        mvuSummary,
        candidates,
        systemPrompt: settings.systemPrompt,
        maxTokens: getRouterRequestMaxTokens(),
        maxSelectCount,
    });
    const promptForParse = result.usedCompactPrompt ? `${prompt}\n\n----- COMPACT RETRY PROMPT -----\n\n${result.retryPrompt}` : prompt;
    const parsed = parseSelectionJson(result.raw, candidates, promptForParse);
    return {
        parsed,
        prompt: promptForParse,
        rawPreview: summarizeRouterResponse(result.raw),
    };
}

async function runSingleAiSelectionAttempt(context, recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
    let parsed;
    let prompt = '';
    let rawPreview = '';
    if (settings.routerUseSeparateModel && settings.routerApiUrl && settings.routerApiKey && settings.routerModel) {
        const result = await selectWithSeparateRouterModel(context, recentMessages, mvuSummary, candidates, maxSelectCount);
        parsed = result.parsed;
        prompt = result.prompt;
        rawPreview = result.rawPreview;
    } else {
        prompt = buildAiPrompt(recentMessages, mvuSummary, candidates, maxSelectCount);
        const raw = await context.generateRaw({
            prompt,
            systemPrompt: settings.systemPrompt,
            responseLength: getRouterRequestMaxTokens(),
            trimNames: false,
            jsonSchema: getSelectionSchema(),
        });
        parsed = parseSelectionJson(raw, candidates, prompt);
        rawPreview = summarizeRouterResponse(raw);
    }

    return { parsed, prompt, rawPreview };
}

async function selectWithAi(context, recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
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
            const result = await runSingleAiSelectionAttempt(context, recentMessages, mvuSummary, candidates, maxSelectCount);
            parsed = result.parsed;
            prompt = result.prompt;
            rawPreview = result.rawPreview;
            break;
        } catch (error) {
            lastError = error;
            prompt = error?.routerPrompt || prompt || '';
            rawPreview = error?.routerRaw || rawPreview || error?.message || String(error);
            debugLog(`Router attempt ${attempt}/${maxAttempts} failed`, error);

            if (!isGatewayLikeError(error) && attempt < maxAttempts) {
                playStatusBurst('retry', 'retry');
                continue;
            }

            playStatusBurst('fail', 'fail');
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

        if (selected.length >= maxSelectCount) {
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

function hasMemoryState(graph) {
    const state = graph?.state || {};
    const customValues = state.custom_values && typeof state.custom_values === 'object' ? state.custom_values : {};
    return !!(
        String(state.current_location || '').trim()
        || String(state.current_time || '').trim()
        || String(state.protagonist_status || '').trim()
        || String(state.current_objective || '').trim()
        || String(state.current_phase || '').trim()
        || (Array.isArray(state.active_topics) && state.active_topics.length)
        || (Array.isArray(state.open_questions) && state.open_questions.length)
        || Object.values(customValues).some(value => String(value || '').trim())
    );
}

function collectMemoryKeywords(node) {
    const keys = [];
    const push = (value) => {
        const text = String(value || '').trim();
        if (text) {
            keys.push(text);
        }
    };

    push(node.id);
    push(node.title);
    push(node.summary);
    push(node.location);
    push(node.timeSpan);
    for (const key of Array.isArray(node.keys) ? node.keys : []) {
        push(key);
    }
    for (const tag of Array.isArray(node.tags) ? node.tags : []) {
        push(tag);
    }

    const snippets = String(node.content || '')
        .split(/[，,。.!?\n；;：:]/u)
        .map(part => part.trim())
        .filter(part => part.length >= 2 && part.length <= 18)
        .slice(0, 8);
    for (const snippet of snippets) {
        push(snippet);
    }

    return uniqueStrings(keys);
}

function buildMemoryCandidates(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    return nodes.map((node, index) => {
        const allKeys = collectMemoryKeywords(node);
        return {
            routerId: `memory:${node.id}`,
            uid: node.id,
            source: 'memory',
            world: 'memory',
            comment: node.title || `记忆 ${index + 1}`,
            content: node.content || node.title || '',
            order: index,
            constant: false,
            disable: false,
            keys: {
                primary: uniqueStrings([node.title, ...(Array.isArray(node.tags) ? node.tags.slice(0, 2) : [])].filter(Boolean)),
                secondary: uniqueStrings(allKeys.slice(1)),
                all: allKeys,
            },
            memoryType: String(node.type || 'event'),
            nodeRef: node,
        };
    });
}

function isMemoryEventType(type) {
    return ['event', 'quest'].includes(String(type || '').toLowerCase());
}

function getMemoryEventNodes(graph) {
    return (Array.isArray(graph?.nodes) ? graph.nodes : [])
        .filter(node => isMemoryEventType(node.type))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getMemoryNonEventNodes(graph) {
    return (Array.isArray(graph?.nodes) ? graph.nodes : [])
        .filter(node => !isMemoryEventType(node.type))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getMemoryStateRows(graph) {
    const state = graph?.state || {};
    const rows = [
        { key: 'current_location', label: 'Current location', value: state.current_location || '' },
        { key: 'current_time', label: 'Current time', value: state.current_time || '' },
        { key: 'protagonist_status', label: 'Protagonist status', value: state.protagonist_status || '' },
        { key: 'current_objective', label: 'Current objective', value: state.current_objective || '' },
        { key: 'current_phase', label: 'Current phase', value: state.current_phase || '' },
        { key: 'active_topics', label: 'Active topics', value: (state.active_topics || []).join(', ') },
        { key: 'open_questions', label: 'Open questions', value: (state.open_questions || []).join(', ') },
    ];
    const customValues = state.custom_values && typeof state.custom_values === 'object' ? state.custom_values : {};
    for (const definition of getCustomMemoryStateDefinitions(graph)) {
        rows.push({
            key: definition.key,
            label: definition.label,
            description: definition.instruction,
            value: String(customValues[definition.key] || ''),
            isCustom: true,
        });
    }
    return rows;
}
function recallMemoryCandidates(graph, recentMessages, mvuSummary) {
    const candidates = recallCandidates(buildMemoryCandidates(graph), recentMessages, mvuSummary)
        .filter(entry => entry.score > 0 || ['event', 'quest', 'character', 'location'].includes(entry.memoryType));

    return candidates
        .sort((a, b) => (b.score - a.score) || String(b.nodeRef?.updatedAt || '').localeCompare(String(a.nodeRef?.updatedAt || '')))
        .slice(0, MAX_MEMORY_SELECTED + 4);
}

function selectMemoryWithFallback(candidates) {
    return candidates.slice(0, MAX_MEMORY_SELECTED).map(entry => ({
        ...entry,
        reason: entry.matchedKeys?.length
            ? `记忆关键词命中：${entry.matchedKeys.join(', ')}`
            : `近期记忆 fallback：${entry.score}`,
    }));
}

function buildMemoryInjection(graph, selectedMemories) {
    const state = graph?.state || {};
    const hasState = hasMemoryState(graph);
    const memoryItems = Array.isArray(selectedMemories) ? selectedMemories : [];
    if (!hasState && !memoryItems.length) {
        return '';
    }

    const parts = ['[本轮相关记忆]\n以下内容来自当前聊天的动态记忆，仅用于本轮回复保持剧情连续性。\n'];

    if (String(state.current_location || '').trim()) {
        parts.push(`\n当前地点：${state.current_location.trim()}\n`);
    }
    if (String(state.current_time || '').trim()) {
        parts.push(`当前时间：${state.current_time.trim()}\n`);
    }
    if (String(state.protagonist_status || '').trim()) {
        parts.push(`主角状态：${state.protagonist_status.trim()}\n`);
    }
    if (String(state.current_objective || '').trim()) {
        parts.push(`当前目标：${state.current_objective.trim()}\n`);
    }
    if (String(state.current_phase || '').trim()) {
        parts.push(`当前阶段：${state.current_phase.trim()}\n`);
    }
    if (Array.isArray(state.active_topics) && state.active_topics.length) {
        parts.push(`活跃主题：${state.active_topics.join('、')}\n`);
    }
    if (Array.isArray(state.open_questions) && state.open_questions.length) {
        parts.push('未解问题：\n');
        for (const question of state.open_questions.slice(0, 6)) {
            parts.push(`- ${question}\n`);
        }
    }
    for (const definition of getCustomMemoryStateDefinitions(graph)) {
        const value = String(state.custom_values?.[definition.key] || '').trim();
        if (!value) {
            continue;
        }
        parts.push(`${definition.label}：${value}\n`);
    }

    if (memoryItems.length) {
        parts.push('\n近期相关记忆：\n');
        for (const entry of memoryItems) {
            const node = entry.nodeRef || {};
            const prefix = [node.timeSpan, node.location].filter(Boolean).join(' | ');
            parts.push(`- ${entry.comment || node.title || entry.uid}${prefix ? ` [${prefix}]` : ''}：${truncateText(node.summary || node.content || entry.content || '', 220)}\n`);
        }
    }

    parts.push('[/本轮相关记忆]');
    return parts.join('');
}

function buildBookshelfInjection(selectedBookshelf = []) {
    const items = Array.isArray(selectedBookshelf) ? selectedBookshelf : [];
    if (!items.length) {
        return '';
    }

    const header = '[本轮相关资料]\n以下片段来自向量书架召回，仅用于补充本轮回复需要的外部资料。\n';
    const footer = '\n[/本轮相关资料]';
    const parts = [header];
    let used = header.length + footer.length;
    const maxChars = Math.max(600, Math.floor(clampNumber(settings.maxChars, defaultSettings.maxChars, 500, 50000) * 0.35));

    for (const item of items) {
        const bookTitle = item.book?.title || item.book?.fileName || item.bookTitle || '未命名资料';
        const chunkTitle = item.title || item.chunk?.title || `片段 ${Number(item.index ?? item.chunk?.index ?? 0) + 1}`;
        const score = Number(item.score || 0);
        const text = String(item.content || item.text || item.chunk?.text || '').trim();
        if (!text) continue;

        const separator = `\n--- ${bookTitle} / ${chunkTitle} | score ${score.toFixed(2)} ---\n`;
        const remaining = maxChars - used - separator.length - footer.length;
        if (remaining <= 0) break;

        const content = truncateText(text, remaining);
        parts.push(separator, content, '\n');
        used += separator.length + content.length + 1;
    }

    if (parts.length === 1) {
        return '';
    }
    parts.push(footer);
    return parts.join('');
}
function buildInjection(selectedEntries, memoryGraph = null, selectedMemories = [], selectedBookshelf = []) {
    const worldbookBlock = (() => {
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
    })();

    const memoryBlock = buildMemoryInjection(memoryGraph || getMemoryGraph(), selectedMemories);
    const bookshelfBlock = buildBookshelfInjection(selectedBookshelf);
    if (!worldbookBlock && !memoryBlock && !bookshelfBlock) {
        return '';
    }
    return [worldbookBlock, memoryBlock, bookshelfBlock].filter(Boolean).join('\n\n');
}

function renderDebugPanel() {
    const candidates = Array.isArray(lastRun?.candidates) ? lastRun.candidates : [];
    const selected = Array.isArray(lastRun?.selected) ? lastRun.selected : [];
    const memoryCandidates = Array.isArray(lastRun?.memoryCandidates) ? lastRun.memoryCandidates : [];
    const selectedMemories = Array.isArray(lastRun?.selectedMemories) ? lastRun.selectedMemories : [];
    const bookshelfCandidates = Array.isArray(lastRun?.bookshelfCandidates) ? lastRun.bookshelfCandidates : [];
    const selectedBookshelf = Array.isArray(lastRun?.selectedBookshelf) ? lastRun.selectedBookshelf : [];
    const pipeline = lastRun?.pipeline && typeof lastRun.pipeline === 'object' ? lastRun.pipeline : null;
    const summary = lastRun.error
        ? `失败：${lastRun.error}`
        : `世界书候选 ${candidates.length} 条，选择 ${selected.length} 条；记忆候选 ${memoryCandidates.length} 条，选择 ${selectedMemories.length} 条；书架候选 ${bookshelfCandidates.length} 条，选择 ${selectedBookshelf.length} 条；注入 ${lastRun.injectedChars} 字符，来源：${lastRun.source}`;
    $('#ai_wbr_last_summary').text(summary);

    const pipelineItems = [];
    if (pipeline) {
        const pre = pipeline.preRefresh || {};
        const graph = pipeline.graph || {};
        const recall = pipeline.recall || {};
        const vector = pipeline.vector || {};
        const sync = vector.sync || {};
        const selectedStats = pipeline.selected || {};
        const injection = pipeline.injection || {};
        const preLabel = pre.attempted
            ? (pre.timedOut ? `预刷新超时，后台继续整理 · ${pre.durationMs || 0}ms` : `预刷新${pre.updated ? '已更新' : '无变化'} · ${pre.durationMs || 0}ms`)
            : `预刷新跳过：${pre.skippedReason || 'not-needed'}`;
        pipelineItems.push(
            $('<div class="ai-wbr-last-item ai-wbr-pipeline-item"></div>')
                .append($('<div></div>').text('[流水线] 记忆预刷新'))
                .append($('<small></small>').text(preLabel)),
            $('<div class="ai-wbr-last-item ai-wbr-pipeline-item"></div>')
                .append($('<div></div>').text('[流水线] 图谱状态'))
                .append($('<small></small>').text(`节点 ${graph.nodes || 0} · 关系 ${graph.links || 0} · 状态 ${graph.hasState ? '有' : '无'}${graph.updatedAt ? ` · 更新 ${graph.updatedAt}` : ''}`)),
            $('<div class="ai-wbr-last-item ai-wbr-pipeline-item"></div>')
                .append($('<div></div>').text('[流水线] 召回候选'))
                .append($('<small></small>').text(`世界书 ${recall.worldbook || 0} · 记忆 ${recall.memory || 0} · 书架 ${recall.bookshelf || 0} · 合计 ${recall.combined || 0}`)),
            $('<div class="ai-wbr-last-item ai-wbr-pipeline-item"></div>')
                .append($('<div></div>').text('[流水线] 向量同步'))
                .append($('<small></small>').text(sync.skipped ? '跳过' : `总 ${sync.total || 0} · ready ${sync.ready || 0} · pending ${sync.pending || 0} · failed ${sync.failed || 0}${vector.errors?.length ? ` · 错误 ${vector.errors.join(' | ')}` : ''}`)),
            $('<div class="ai-wbr-last-item ai-wbr-pipeline-item"></div>')
                .append($('<div></div>').text('[流水线] 最终注入'))
                .append($('<small></small>').text(`世界书 ${selectedStats.worldbook || 0} · 记忆 ${selectedStats.memory || 0} · 资料 ${selectedStats.bookshelf || 0} · 字符 ${injection.chars || lastRun.injectedChars || 0}`)),
        );
    }

    const worldbookItems = selected.map(entry => {
        const title = entry.comment || entry.keys?.primary?.[0] || entry.uid;
        const keys = entry.matchedKeys?.length ? ` | keys: ${entry.matchedKeys.join(', ')}` : '';
        return $('<div class="ai-wbr-last-item"></div>')
            .append($('<div></div>').text(`${title} (${entry.world || entry.source}#${entry.uid})`))
            .append($('<small></small>').text(`${entry.reason || entry.recallReason || ''}${keys}${entry.sourceType ? ` · ${entry.sourceType}` : ''}`));
    });

    const memoryItems = selectedMemories.map(entry => {
        const title = entry.comment || entry.uid;
        const keys = entry.matchedKeys?.length ? ` | keys: ${entry.matchedKeys.join(', ')}` : '';
        return $('<div class="ai-wbr-last-item"></div>')
            .append($('<div></div>').text(`[记忆] ${title} (${entry.memoryType || 'memory'}#${entry.uid})`))
            .append($('<small></small>').text(`${entry.reason || entry.recallReason || ''}${keys}${entry.sourceType ? ` · ${entry.sourceType}` : ''}`));
    });

    const bookshelfItems = selectedBookshelf.map(entry => (
        $('<div class="ai-wbr-last-item"></div>')
            .append($('<div></div>').text(`[书架] 《${entry.book?.title || entry.book?.fileName || '书架'}》 / ${entry.title || entry.uid}`))
            .append($('<small></small>').text(`${entry.recallReason || `分数 ${Number(entry.score || 0).toFixed(2)}`} · ${truncateText(entry.text || entry.content || '', 120)}`))
    ));

    $('#ai_wbr_last_items').empty().append([...pipelineItems, ...worldbookItems, ...memoryItems, ...bookshelfItems]);
    $('#ai_wbr_injection_text').text(lastRun.injectionText || '尚无本轮注入记录');
    $('#ai_wbr_router_prompt').text(lastRun.routerPrompt || '尚无前置 AI Prompt 记录');
    $('#ai_wbr_router_raw').text(lastRun.routerRaw || '尚无前置 AI 返回记录');
    renderStandaloneConsole();
}

function getStandaloneStatusMeta() {
    if (!settings.enabled) {
        return { label: 'Disabled', className: 'idle', icon: 'fa-pause-circle' };
    }
    if (lastRun.error) {
        return { label: 'Route error', className: 'error', icon: 'fa-triangle-exclamation' };
    }
    if (lastRun.source && lastRun.source !== 'none') {
        const isFallback = lastRun.source.includes('fallback');
        return { label: isFallback ? 'Fallback route' : 'Route complete', className: isFallback ? 'warn' : 'ok', icon: isFallback ? 'fa-rotate-left' : 'fa-circle-check' };
    }
    if (settings.routerStatus && !['???', '???', 'Ready'].includes(settings.routerStatus)) {
        return { label: settings.routerStatus, className: 'active', icon: 'fa-bolt' };
    }
    return { label: 'Waiting', className: 'ready', icon: 'fa-circle-dot' };
}
function createStandaloneStat(label, value) {
    return $('<div class="ai-wbr-console-stat"></div>')
        .append($('<div class="ai-wbr-console-stat-value"></div>').text(value))
        .append($('<div class="ai-wbr-console-stat-label"></div>').text(label));
}

function createStandaloneEntryCard(entry = {}, type = 'worldbook', selected = false) {
    const keyData = entry.keys && typeof entry.keys === 'object' && !Array.isArray(entry.keys) && Array.isArray(entry.keys.all)
        ? entry.keys
        : getEntryKeys(entry);
    const primaryKeys = Array.isArray(keyData.primary) ? keyData.primary : [];
    const allKeys = Array.isArray(keyData.all) ? keyData.all : [];
    const matchedKeys = Array.isArray(entry.matchedKeys)
        ? entry.matchedKeys
        : (entry.matchedKeys ? [entry.matchedKeys] : []);
    const title = entry.comment
        || entry.recallTitle
        || primaryKeys[0]
        || entry.title
        || entry.uid
        || entry.id
        || 'Untitled entry';
    const source = type === 'memory'
        ? `${entry.memoryType || entry.sourceType || 'memory'}#${entry.uid || entry.id || ''}`
        : type === 'bookshelf'
            ? `${entry.book?.title || entry.book?.fileName || 'bookshelf'}#${entry.uid || entry.id || ''}`
            : `${entry.world || entry.source || entry.sourceType || 'worldbook'}#${entry.uid || entry.id || ''}`;
    const keys = matchedKeys.length ? matchedKeys.map(String).join(', ') : allKeys.map(String).join(', ');
    const body = entry.content || entry.text || entry.chunk?.text || '';
    const reason = entry.reason || entry.recallReason || '';

    return $('<div class="ai-wbr-console-entry"></div>')
        .toggleClass('selected', !!selected)
        .append($('<div class="ai-wbr-console-entry-head"></div>')
            .append($('<b></b>').text(title))
            .append($('<span></span>').text(selected ? 'Injected' : 'Candidate')))
        .append($('<div class="ai-wbr-console-entry-meta"></div>').text(source))
        .append(keys ? $('<div class="ai-wbr-console-entry-keys"></div>').text(`keys: ${truncateText(keys, 160)}`) : '')
        .append(reason ? $('<small></small>').text(reason) : '')
        .append(body ? $('<p></p>').text(truncateText(body, 320)) : '');
}

function appendStandaloneEntryCard(list, entry, type, selected) {
    try {
        list.append(createStandaloneEntryCard(entry, type, selected));
    } catch (error) {
        console.warn(`${LOG_PREFIX} failed to render ${type} route candidate`, error, entry);
        const title = entry?.comment || entry?.title || entry?.uid || entry?.id || 'Bad route candidate';
        list.append($('<div class="ai-wbr-console-entry"></div>')
            .toggleClass('selected', !!selected)
            .append($('<div class="ai-wbr-console-entry-head"></div>')
                .append($('<b></b>').text(title))
                .append($('<span></span>').text(selected ? 'Injected' : 'Candidate')))
            .append($('<div class="ai-wbr-console-entry-meta"></div>').text(`${type}#${entry?.uid || entry?.id || ''}`))
            .append($('<small></small>').text(`候选字段不完整，已跳过部分详情：${error?.message || error}`)));
    }
}
function getStandaloneTabId() {
    return String($('#ai_wbr_console_tabs .ai-wbr-console-tab.active').data('tab') || 'overview');
}

function createBookshelfStandaloneFold() {
    return $(`
        <details class="ai-wbr-memory-fold ai-wbr-bookshelf-fold" open>
            <summary>
                <span>书架</span>
                <small>导入 TXT，向量化后按当前剧情语义召回。</small>
            </summary>
            <div id="ai_wbr_bookshelf_panel" class="ai-wbr-memory-fold-body ai-wbr-bookshelf-panel">
                <div class="ai-wbr-bookshelf-app">
                    <div class="ai-wbr-bookshelf-top">
                        <div class="ai-wbr-bookshelf-title">书架</div>
                        <button id="ai_wbr_bookshelf_open_settings" class="ai-wbr-bookshelf-more" type="button" title="书架设置">•••</button>
                    </div>
                    <div class="ai-wbr-bookshelf-tabs">
                        <span class="ai-wbr-bookshelf-read-badge">向量召回</span>
                        <button id="ai_wbr_bookshelf_import" class="ai-wbr-bookshelf-link" type="button">导入TXT</button>
                            <button id="ai_wbr_bookshelf_build_memory_books" class="ai-wbr-bookshelf-link" type="button">刷新记忆书</button>
                        <button id="ai_wbr_bookshelf_test_open" class="ai-wbr-bookshelf-link" type="button">召回测试</button>
                    </div>

                    <input id="ai_wbr_bookshelf_file" type="file" accept=".txt,text/plain" multiple hidden />
                    <div id="ai_wbr_bookshelf_status" class="ai-wbr-bookshelf-status">书架待命。导入 TXT 后点击书籍向量化。</div>
                    <div id="ai_wbr_bookshelf_books" class="ai-wbr-bookshelf-books"></div>
                    <div id="ai_wbr_bookshelf_detail" class="ai-wbr-bookshelf-detail"></div>

                    <div class="ai-wbr-bookshelf-test" id="ai_wbr_bookshelf_test_panel">
                        <div class="ai-wbr-memory-subtitle"><b>召回测试</b></div>
                        <textarea id="ai_wbr_bookshelf_test_query" class="text_pole" rows="3" placeholder="输入一句当前剧情问题，测试向量书架会召回哪些片段。"></textarea>
                        <div class="ai-wbr-bookshelf-actions">
                            <button id="ai_wbr_bookshelf_test" class="menu_button" type="button">测试召回</button>
                        </div>
                        <div id="ai_wbr_bookshelf_results" class="ai-wbr-bookshelf-results"></div>
                    </div>

                    <div class="ai-wbr-bookshelf-drawer-backdrop" id="ai_wbr_bookshelf_settings_backdrop"></div>
                    <aside class="ai-wbr-bookshelf-settings-drawer" id="ai_wbr_bookshelf_settings_drawer" aria-hidden="true">
                        <div class="ai-wbr-bookshelf-drawer-head">
                            <div>
                                <b>书架设置</b>
                                <small id="ai_wbr_bookshelf_model_status">未测试</small>
                            </div>
                            <button id="ai_wbr_bookshelf_close_settings" class="menu_button" type="button">关闭</button>
                        </div>
                        <div id="ai_wbr_bookshelf_scope" class="ai-wbr-bookshelf-scope"></div>
                        <div class="ai-wbr-bookshelf-import-options">
                            <label for="ai_wbr_bookshelf_import_type">导入分类</label>
                            <select id="ai_wbr_bookshelf_import_type" class="text_pole">
                                <option value="plot">剧情记录</option>
                                <option value="character">人物档案</option>
                                <option value="world">世界观</option>
                                <option value="rule">规则设定</option>
                                <option value="other">其他资料</option>
                            </select>
                            <label>\u7ed1\u5b9a\u903b\u8f91</label>
                            <div class="ai-wbr-bookshelf-bind-note">\u5bfc\u5165 TXT \u53ea\u5165\u5e93\uff1b\u5b8c\u6210\u5206\u5272\u5411\u91cf\u5316\u540e\uff0c\u624b\u52a8\u7ed1\u5b9a\u5f53\u524d\u89d2\u8272\u5361\u5373\u53ef\u5728\u8be5\u89d2\u8272\u7684\u5404\u4e2a\u804a\u5929\u4e2d\u81ea\u52a8\u751f\u6548\uff0c\u4e5f\u53ef\u8bbe\u4e3a\u5168\u5c40\u6216\u968f\u65f6\u53d6\u6d88\u7ed1\u5b9a\u3002</div>
                        </div>
                        <div class="ai-wbr-bookshelf-switches">
                            <label class="checkbox_label" for="ai_wbr_bookshelf_enabled"><input id="ai_wbr_bookshelf_enabled" type="checkbox" />启用向量召回</label>
                            <label class="checkbox_label" for="ai_wbr_bookshelf_auto_inject"><input id="ai_wbr_bookshelf_auto_inject" type="checkbox" />生成前自动注入</label>
                            <label class="checkbox_label" for="ai_wbr_bookshelf_auto_memory_book"><input id="ai_wbr_bookshelf_auto_memory_book" type="checkbox" />自动维护当前聊天记忆书</label>
                            <label class="checkbox_label" for="ai_wbr_bookshelf_memory_vector"><input id="ai_wbr_bookshelf_memory_vector" type="checkbox" />图谱记忆参与召回</label>
                            <label class="checkbox_label" for="ai_wbr_bookshelf_only_bound"><input id="ai_wbr_bookshelf_only_bound" type="checkbox" />仅召回绑定书籍</label>
                            <label class="checkbox_label" for="ai_wbr_bookshelf_allow_global"><input id="ai_wbr_bookshelf_allow_global" type="checkbox" />允许全局书籍</label>
                        </div>
                        <div class="ai-wbr-grid ai-wbr-bookshelf-config">
                            <label for="ai_wbr_bookshelf_embedding_mode">Embedding 模式</label>
                            <select id="ai_wbr_bookshelf_embedding_mode" class="text_pole">
                                <option value="api">API 向量模型</option>
                                <option value="browser-local">浏览器本地模型</option>
                            </select>
                            <label for="ai_wbr_bookshelf_api_url">API 地址</label>
                            <input id="ai_wbr_bookshelf_api_url" class="text_pole" type="text" placeholder="https://example.com/v1 或 /v1/embeddings" />
                            <label for="ai_wbr_bookshelf_api_key">API Key</label>
                            <input id="ai_wbr_bookshelf_api_key" class="text_pole" type="password" placeholder="sk-..." />
                            <label for="ai_wbr_bookshelf_api_model">API 模型</label>
                            <select id="ai_wbr_bookshelf_api_model" class="text_pole">
                                <option value="">先点击“获取模型”</option>
                            </select>
                            <label></label>
                            <button id="ai_wbr_bookshelf_fetch_models" class="menu_button" type="button">获取模型</button>
                            <label for="ai_wbr_bookshelf_local_model">本地模型 ID</label>
                            <input id="ai_wbr_bookshelf_local_model" class="text_pole" type="text" placeholder="Xenova/paraphrase-multilingual-MiniLM-L12-v2" />
                            <label for="ai_wbr_bookshelf_memory_vector_max">图谱召回数量</label>
                            <input id="ai_wbr_bookshelf_memory_vector_max" class="text_pole" type="number" min="1" max="12" step="1" />
                            <label for="ai_wbr_bookshelf_max_chunks">TXT 召回数量</label>
                            <input id="ai_wbr_bookshelf_max_chunks" class="text_pole" type="number" min="1" max="12" step="1" />
                            <label for="ai_wbr_bookshelf_max_chars">每段最大字数</label>
                            <input id="ai_wbr_bookshelf_max_chars" class="text_pole" type="number" min="120" max="2000" step="20" />
                            <label for="ai_wbr_bookshelf_min_score">最低相似度</label>
                            <input id="ai_wbr_bookshelf_min_score" class="text_pole" type="number" min="0" max="1" step="0.05" />
                        </div>
                        <div class="ai-wbr-bookshelf-actions">
                            <button id="ai_wbr_bookshelf_test_provider" class="menu_button" type="button">测试向量模型</button>
                            <button id="ai_wbr_bookshelf_load_local" class="menu_button" type="button">下载/加载本地模型</button>
                            <button id="ai_wbr_bookshelf_build_memory_books" class="menu_button" type="button">刷新当前聊天记忆书</button>
                            <button id="ai_wbr_bookshelf_vectorize_memory" class="menu_button" type="button">同步图谱向量</button>
                            <button id="ai_wbr_bookshelf_reset_memory_vectors" class="menu_button" type="button">重置图谱向量</button>
                        </div>
                    </aside>
                </div>
            </div>
        </details>
    `);
}

function ensureBookshelfStandaloneControls(section) {
    const panel = section.find('#ai_wbr_bookshelf_panel');
    if (!panel.length) return;
    if (!panel.find('.ai-wbr-bookshelf-app').length) {
        const rebuiltPanel = createBookshelfStandaloneFold().find('#ai_wbr_bookshelf_panel');
        panel.empty().append(rebuiltPanel.children());
    }
    const switches = panel.find('.ai-wbr-bookshelf-switches').first();
    if (switches.length && !panel.find('#ai_wbr_bookshelf_memory_vector').length) {
        switches.find('#ai_wbr_bookshelf_auto_inject').closest('label').after(
            $('<label class="checkbox_label" for="ai_wbr_bookshelf_memory_vector"></label>')
                .append('<input id="ai_wbr_bookshelf_memory_vector" type="checkbox" />')
                .append('图谱记忆参与向量召回'),
        );
    }
    if (switches.length && !panel.find('#ai_wbr_bookshelf_auto_memory_book').length) {
        switches.find('#ai_wbr_bookshelf_auto_inject').closest('label').after(
            $('<label class="checkbox_label" for="ai_wbr_bookshelf_auto_memory_book"></label>')
                .append('<input id="ai_wbr_bookshelf_auto_memory_book" type="checkbox" />')
                .append('自动维护当前聊天记忆书'),
        );
    }
    const config = panel.find('.ai-wbr-bookshelf-config').first();
    if (config.length && !panel.find('#ai_wbr_bookshelf_memory_vector_max').length) {
        config.find('#ai_wbr_bookshelf_max_chunks').prev('label').before('<label for="ai_wbr_bookshelf_memory_vector_max">图谱召回数量</label>');
        config.find('#ai_wbr_bookshelf_max_chunks').before('<input id="ai_wbr_bookshelf_memory_vector_max" class="text_pole" type="number" min="1" max="12" step="1" />');
    }
    const actions = panel.find('.ai-wbr-bookshelf-actions').first();
    const tabs = panel.find('.ai-wbr-bookshelf-tabs').first();
    if (tabs.length && !panel.find('#ai_wbr_bookshelf_build_memory_books').length) {
        tabs.find('#ai_wbr_bookshelf_import').after('<button id="ai_wbr_bookshelf_build_memory_books" class="ai-wbr-bookshelf-link" type="button">刷新记忆书</button>');
    }
    if (actions.length && !panel.find('#ai_wbr_bookshelf_build_memory_books').length) {
        actions.find('#ai_wbr_bookshelf_load_local').after('<button id="ai_wbr_bookshelf_build_memory_books" class="menu_button" type="button">刷新当前聊天记忆书</button>');
    }
    if (actions.length && !panel.find('#ai_wbr_bookshelf_vectorize_memory').length) {
        actions.find('#ai_wbr_bookshelf_load_local').after('<button id="ai_wbr_bookshelf_vectorize_memory" class="menu_button" type="button">同步图谱向量</button>');
    }
    if (actions.length && !panel.find('#ai_wbr_bookshelf_reset_memory_vectors').length) {
        actions.find('#ai_wbr_bookshelf_vectorize_memory').after('<button id="ai_wbr_bookshelf_reset_memory_vectors" class="menu_button" type="button">重置图谱向量</button>');
    }
    if (panel.find('#ai_wbr_bookshelf_api_model').is('input')) {
        const currentValue = String(panel.find('#ai_wbr_bookshelf_api_model').val() || settings.bookshelfApiModel || '').trim();
        panel.find('#ai_wbr_bookshelf_api_model').replaceWith(
            $('<select id="ai_wbr_bookshelf_api_model" class="text_pole"></select>')
                .append($('<option></option>', { value: currentValue, text: currentValue || 'Fetch models first' })),
        );
    }
    if (!panel.find('#ai_wbr_bookshelf_fetch_models').length) {
        const modelField = panel.find('#ai_wbr_bookshelf_api_model');
        modelField.after('<button id="ai_wbr_bookshelf_fetch_models" class="menu_button" type="button">获取模型</button>');
    }
}

function ensureBookshelfStandaloneSection() {
    let section = $('#ai_wbr_bookshelf_section');
    if (!section.length) {
        section = $('<div class="ai-wbr-section" id="ai_wbr_bookshelf_section"></div>');
    }
    const fold = $('.ai-wbr-bookshelf-fold');
    if (fold.length && !section.find('#ai_wbr_bookshelf_panel').length) {
        section.append(fold.detach());
    }
    if (!section.find('#ai_wbr_bookshelf_panel').length) {
        section.empty().append(createBookshelfStandaloneFold());
    }
    ensureBookshelfStandaloneControls(section);
    return section;
}

function getSettingsContentContainer() {
    return $('#ai_worldbook_router_settings .inline-drawer-content').first();
}

function restoreStandalonePanelsToSettings() {
    const settingsContent = getSettingsContentContainer();
    if (!settingsContent.length) return;

    const memorySection = $('#ai_wbr_memory_section');
    const graphSection = $('#ai_wbr_memory_graph_section');
    const bookshelfSection = $('#ai_wbr_bookshelf_section');
    const debugSection = settingsContent.find('.ai-wbr-debug').first();

    if (memorySection.length && !settingsContent.find('#ai_wbr_memory_section').length) {
        const routerSection = settingsContent.find('.ai-wbr-section')
            .not('#ai_wbr_memory_section, #ai_wbr_memory_graph_section, #ai_wbr_bookshelf_section')
            .first();
        if (routerSection.length) {
            routerSection.after(memorySection.detach());
        } else {
            settingsContent.append(memorySection.detach());
        }
    }
    if (graphSection.length && !settingsContent.find('#ai_wbr_memory_graph_section').length) {
        if (debugSection.length) {
            debugSection.before(graphSection.detach());
        } else {
            settingsContent.append(graphSection.detach());
        }
    }
    if (bookshelfSection.length && !settingsContent.find('#ai_wbr_bookshelf_section').length) {
        const targetMemorySection = settingsContent.find('#ai_wbr_memory_section');
        if (targetMemorySection.length && !targetMemorySection.find('#ai_wbr_bookshelf_panel').length) {
            targetMemorySection.append(bookshelfSection.detach());
        }
    }
}

function parkStandalonePanels(...selectors) {
    let parking = $('#ai_wbr_console_parking');
    if (!parking.length) {
        parking = $('<div id="ai_wbr_console_parking" class="ai-wbr-console-parking"></div>');
        $('body').append(parking);
    }
    ensureBookshelfStandaloneSection();
    const targetSelectors = selectors.length ? selectors : ['#ai_wbr_memory_section', '#ai_wbr_memory_graph_section', '#ai_wbr_bookshelf_section'];
    $(targetSelectors.join(', ')).detach().appendTo(parking);
}

function renderStandaloneOverview(container) {
    const candidates = Array.isArray(lastRun?.candidates) ? lastRun.candidates : [];
    const selected = Array.isArray(lastRun?.selected) ? lastRun.selected : [];
    const memoryCandidates = Array.isArray(lastRun?.memoryCandidates) ? lastRun.memoryCandidates : [];
    const selectedMemories = Array.isArray(lastRun?.selectedMemories) ? lastRun.selectedMemories : [];
    const status = getStandaloneStatusMeta();

    container.append($('<div class="ai-wbr-console-hero"></div>')
        .append($('<div></div>')
            .append($('<div class="ai-wbr-console-kicker"></div>').text('AI Worldbook Router'))
            .append($('<h3></h3>').text('世界书读取控制台'))
            .append($('<p></p>').text('Select relevant worldbook, memory, and state before injecting into the current prompt.')))
        .append($('<div class="ai-wbr-console-status-pill"></div>')
            .addClass(status.className)
            .append($(`<i class="fa-solid ${status.icon}"></i>`))
            .append($('<span></span>').text(status.label))));

    container.append($('<div class="ai-wbr-console-stats"></div>')
        .append(createStandaloneStat('世界书候选', candidates.length))
        .append(createStandaloneStat('世界书命中', selected.length))
        .append(createStandaloneStat('记忆候选', memoryCandidates.length))
        .append(createStandaloneStat('记忆命中', selectedMemories.length))
        .append(createStandaloneStat('注入字符', lastRun.injectedChars || 0))
        .append(createStandaloneStat('路由来源', lastRun.source || 'none')));

    container.append($('<div class="ai-wbr-console-actions"></div>')
        .append($('<button class="menu_button" type="button"></button>').text(settings.enabled ? '关闭路由' : '启用路由').on('click', () => {
            saveSetting('enabled', !settings.enabled);
            $('#ai_wbr_enabled').prop('checked', !!settings.enabled);
            renderStandaloneConsole();
        }))
        .append($('<button class="menu_button" type="button">刷新状态</button>').on('click', () => {
            renderActiveWorldbookSelector();
            renderDebugPanel();
            renderMemoryPanel();
        }))
        .append($('<button class="menu_button" type="button">复制注入文本</button>').on('click', async () => {
            await navigator.clipboard?.writeText?.(lastRun.injectionText || '');
            toastr?.success?.('Done.', 'AI Worldbook Router');
        })));

    if (lastRun.error) {
        container.append($('<div class="ai-wbr-console-alert error"></div>').text(lastRun.error));
    }
}

function renderStandaloneRoutes(container) {
    const selectedIds = new Set((lastRun.selected || []).map(entry => getEntryId(entry, entry.uid)));
    const memorySelectedIds = new Set((lastRun.selectedMemories || []).map(entry => String(entry.uid)));
    const bookshelfSelectedIds = new Set((lastRun.selectedBookshelf || []).map(entry => String(entry.uid || entry.id)));
    const candidates = Array.isArray(lastRun.candidates) ? lastRun.candidates : [];
    const memoryCandidates = Array.isArray(lastRun.memoryCandidates) ? lastRun.memoryCandidates : [];
    const bookshelfCandidates = Array.isArray(lastRun.bookshelfCandidates) ? lastRun.bookshelfCandidates : [];
    const list = $('<div class="ai-wbr-console-entry-list"></div>');

    container.append($('<div class="ai-wbr-console-section-title"></div>').text('世界书路由结果'));
    if (!candidates.length && !memoryCandidates.length && !bookshelfCandidates.length) {
        list.append($('<div class="ai-wbr-console-empty"></div>').text('尚无路由记录。下一次生成后会显示候选与命中条目。'));
    }
    for (const entry of candidates) {
        appendStandaloneEntryCard(list, entry, 'worldbook', selectedIds.has(getEntryId(entry, entry.uid)));
    }
    for (const entry of memoryCandidates) {
        appendStandaloneEntryCard(list, entry, 'memory', memorySelectedIds.has(String(entry.uid)));
    }
    for (const entry of bookshelfCandidates) {
        appendStandaloneEntryCard(list, entry, 'bookshelf', bookshelfSelectedIds.has(String(entry.uid || entry.id)));
    }
    container.append(list);
}

function renderStandaloneInjection(container) {
    container.append($('<div class="ai-wbr-console-section-head"></div>')
        .append($('<div class="ai-wbr-console-section-title"></div>').text('本轮最终注入文本'))
        .append($('<button class="menu_button" type="button">复制</button>').on('click', async () => {
            await navigator.clipboard?.writeText?.(lastRun.injectionText || '');
            toastr?.success?.('Done.', 'AI Worldbook Router');
        })));
    container.append($('<pre class="ai-wbr-console-pre"></pre>').text(lastRun.injectionText || '尚无本轮注入记录'));
}

function renderStandaloneModel(container) {
    container.append($('<div class="ai-wbr-console-section-title"></div>').text('独立路由模型'));
    const panel = $('<div class="ai-wbr-console-form"></div>');
    panel.append($('<label class="checkbox_label"></label>')
        .append($('<input type="checkbox" />').prop('checked', !!settings.routerUseSeparateModel).on('input', function () {
            saveSetting('routerUseSeparateModel', !!$(this).prop('checked'));
            $('#ai_wbr_router_use_separate_model').prop('checked', !!settings.routerUseSeparateModel);
            renderStandaloneConsole();
        }))
        .append($('<span></span>').text('启用独立路由模型')));
    panel.append($('<label></label>').text('API URL'));
    panel.append($('<input class="text_pole" type="text" />').val(settings.routerApiUrl || '').on('input', function () {
        saveSetting('routerApiUrl', normalizeUrl($(this).val()));
        $('#ai_wbr_router_api_url').val(settings.routerApiUrl);
    }));
    panel.append($('<label></label>').text('API Key'));
    panel.append($('<input class="text_pole" type="password" />').val(settings.routerApiKey || '').on('input', function () {
        saveSetting('routerApiKey', String($(this).val() || '').trim());
        $('#ai_wbr_router_api_key').val(settings.routerApiKey);
    }));
    panel.append($('<label></label>').text('路由模型'));

    const select = $('<select class="text_pole"></select>').append('<option value="">未选择</option>');
    for (const modelId of settings.routerModels || []) {
        select.append($('<option></option>', { value: modelId, text: modelId, selected: modelId === settings.routerModel }));
    }
    if (settings.routerModel && !(settings.routerModels || []).includes(settings.routerModel)) {
        select.append($('<option></option>', { value: settings.routerModel, text: `${settings.routerModel} (手动)`, selected: true }));
    }
    panel.append(select.on('change', function () {
        saveSetting('routerModel', String($(this).val() || ''));
        $('#ai_wbr_router_model').val(settings.routerModel);
    }));
    panel.append($('<div class="ai-wbr-console-actions"></div>')
        .append($('<button class="menu_button" type="button">拉取模型</button>').on('click', fetchRouterModels))
        .append($('<span class="ai-wbr-status"></span>').text(settings.routerStatus || '未连接')));
    container.append(panel);
}

function createStandaloneSettingsToggle(label, key, description = '', afterSave = null) {
    return $('<label class="checkbox_label"></label>')
        .append($('<input type="checkbox" />')
            .prop('checked', !!settings[key])
            .on('input', function () {
                saveSetting(key, !!$(this).prop('checked'));
                $(`#ai_wbr_${String(key).replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`).prop('checked', !!settings[key]);
                if (typeof afterSave === 'function') afterSave();
                renderStandaloneConsole('settings');
            }))
        .append($('<span></span>').text(label))
        .append(description ? $('<small></small>').text(description) : '');
}

function createStandaloneSettingsNav(label, tabId, description) {
    return $('<button class="menu_button" type="button"></button>')
        .append($('<b></b>').text(label))
        .append(description ? $('<small></small>').text(description) : '')
        .on('click', () => renderStandaloneConsole(tabId));
}

function renderStandaloneSettings(container) {
    container.append($('<div class="ai-wbr-console-section-title"></div>').text('核心设置'));
    container.append(
        $('<div class="ai-wbr-console-form"></div>')
            .append(createStandaloneSettingsToggle('启用前置 AI 世界书路由', 'enabled', '控制正式生成前是否筛选并注入世界书。'))
            .append(createStandaloneSettingsToggle('启用记忆存储', 'memoryEnabled', '开启后才会整理聊天记忆和刷新图谱。'))
            .append(createStandaloneSettingsToggle('实时整理聊天记忆', 'memoryRealtimeEnabled', '生成结束后自动整理最近消息。'))
            .append(createStandaloneSettingsToggle('间隔归纳整理', 'memorySummaryEnabled', '按消息间隔压缩阶段剧情和关系变化。'))
            .append(createStandaloneSettingsToggle('记忆状态参与路由', 'memoryInjectToRouter', '让图谱摘要辅助世界书路由命中。'))
            .append(createStandaloneSettingsToggle('启用书架补充召回', 'bookshelfEnabled', '允许书架和记忆书参与向量召回。'))
            .append(createStandaloneSettingsToggle('自动维护当前聊天记忆书', 'bookshelfAutoMemoryBook', '从当前图谱自动生成聊天绑定记忆书。', () => {
                if (settings.bookshelfAutoMemoryBook) {
                    scheduleBookshelfMemoryBookSync(getContext(), { force: true, silent: false, delayMs: 100 });
                }
            })),
    );

    container.append($('<div class="ai-wbr-console-section-title"></div>').text('设置分区'));
    container.append(
        $('<div class="ai-wbr-console-actions ai-wbr-console-settings-nav"></div>')
            .append(createStandaloneSettingsNav('记忆设置', 'memory', '整理、历史补录、JSON 和调试。'))
            .append(createStandaloneSettingsNav('图谱视图', 'graph', '全屏图谱、布局和详情面板。'))
            .append(createStandaloneSettingsNav('书架设置', 'bookshelf', '记忆书、向量模型和召回测试。'))
            .append(createStandaloneSettingsNav('调试信息', 'debug', '查看前置 Prompt、返回和错误。')),
    );

    renderStandaloneModel(container);
}

function renderStandaloneDebug(container) {
    container.append($('<div class="ai-wbr-console-section-title"></div>').text('前置 AI Prompt'));
    container.append($('<pre class="ai-wbr-console-pre"></pre>').text(lastRun.routerPrompt || '尚无前置 AI Prompt 记录'));
    container.append($('<div class="ai-wbr-console-section-title"></div>').text('前置 AI 原始返回'));
    container.append($('<pre class="ai-wbr-console-pre"></pre>').text(lastRun.routerRaw || '尚无前置 AI 返回记录'));
    if (lastRun.error) {
        container.append($('<div class="ai-wbr-console-section-title"></div>').text('错误'));
        container.append($('<pre class="ai-wbr-console-pre error"></pre>').text(lastRun.error));
    }
}

function renderStandaloneConsole(tabId = getStandaloneTabId()) {
    const body = $('#ai_wbr_console_body');
    if (!body.length) {
        return;
    }

    restoreStandalonePanelsToSettings();
    const isGraphTab = tabId === 'graph';
    if (!isGraphTab && memoryGraphFullscreenActive) {
        setMemoryGraphFullscreen(false, { fit: false });
    }
    $('#ai_wbr_floating_window').toggleClass('ai-wbr-floating-window-graph', isGraphTab);
    body.toggleClass('ai-wbr-console-body-graph', isGraphTab);
    $('#ai_wbr_console_tabs .ai-wbr-console-tab').removeClass('active')
        .filter(`[data-tab="${escapeCssSelector(tabId)}"]`).addClass('active');
    body.empty();

    if (tabId === 'overview') {
        renderStandaloneOverview(body);
    } else if (tabId === 'routes') {
        renderStandaloneRoutes(body);
    } else if (tabId === 'injection') {
        renderStandaloneInjection(body);
    } else if (tabId === 'memory') {
        parkStandalonePanels('#ai_wbr_memory_section');
        body.append($('#ai_wbr_memory_section'));
        renderMemoryPanel('memory');
    } else if (tabId === 'graph') {
        parkStandalonePanels('#ai_wbr_memory_graph_section');
        body.append($('#ai_wbr_memory_graph_section'));
        renderMemoryPanel('graph');
        requestAnimationFrame(() => {
            if (getStandaloneTabId() === 'graph' && $('#ai_wbr_memory_graph').is(':visible')) {
                fitMemoryGraphToContainer();
                renderMemoryPanel('graph');
            }
        });
    } else if (tabId === 'bookshelf') {
        parkStandalonePanels('#ai_wbr_bookshelf_section');
        body.append(ensureBookshelfStandaloneSection());
        syncBookshelfProviderVisibility();
        renderBookshelfPanel();
    } else if (tabId === 'debug') {
        renderStandaloneDebug(body);
    } else if (tabId === 'settings') {
        renderStandaloneSettings(body);
    }

    const status = getStandaloneStatusMeta();
    $('#ai_wbr_fab').removeClass('idle ready active ok warn error').addClass(status.className).attr('title', `世界书读取：${status.label}`);
    $('#ai_wbr_console_status').removeClass('idle ready active ok warn error').addClass(status.className).text(status.label);
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

function getMemoryGraphSearchHaystack(node) {
    return [
        node?.id,
        node?.title,
        node?.summary,
        node?.content,
        node?.location,
        node?.timeSpan,
        node?.type,
        ...(Array.isArray(node?.keys) ? node.keys : []),
        ...(Array.isArray(node?.tags) ? node.tags : []),
    ].map(value => String(value || '').toLowerCase()).join('\n');
}

function getMemoryGraphNodeScore(node, degree = 0, index = 0) {
    const importance = clampNumber(node?.importance, 0.5, 0, 1);
    const updatedAt = Date.parse(node?.updatedAt || node?.createdAt || '') || 0;
    const recencyBoost = updatedAt ? Math.min(0.35, Math.max(0, updatedAt / Math.max(1, Date.now()) * 0.35)) : 0;
    return (degree * 1.6) + importance + recencyBoost + (1 / Math.max(10, index + 10));
}

function buildMemoryGraphDisplayModel(graph) {
    const allNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const allLinks = Array.isArray(graph?.links) ? graph.links : [];
    const nodeById = new Map(allNodes.map(node => [String(node.id), node]));
    const selectedNodeId = String(memoryGraphSelectedNodeId || '');
    const selectedLinkId = String(memoryGraphSelectedLinkId || '');
    const query = String(memoryGraphSearchText || '').trim().toLowerCase();
    const minWeight = clampNumber(memoryGraphMinLinkWeight, 0.35, 0, 1);
    const typeFilter = memoryGraphVisibleTypes instanceof Set ? memoryGraphVisibleTypes : new Set();
    const hasTypeFilter = typeFilter.size > 0;
    const degree = new Map(allNodes.map(node => [String(node.id), 0]));

    for (const link of allLinks) {
        const source = String(link?.source || '');
        const target = String(link?.target || '');
        if (!nodeById.has(source) || !nodeById.has(target)) {
            continue;
        }
        const weight = clampNumber(link?.weight, 0.5, 0, 1);
        degree.set(source, (degree.get(source) || 0) + weight);
        degree.set(target, (degree.get(target) || 0) + weight);
    }

    const typeFilteredNodes = allNodes.filter((node) => {
        const type = String(node?.type || 'event');
        return !hasTypeFilter || typeFilter.has(type);
    });
    const typeFilteredIds = new Set(typeFilteredNodes.map(node => String(node.id)));
    let mode = String(memoryGraphDisplayMode || 'overview');
    if (mode === 'focus' && (!selectedNodeId || !nodeById.has(selectedNodeId))) {
        mode = 'overview';
    }

    let candidateIds = new Set(typeFilteredIds);
    if (query) {
        const matchedIds = new Set(typeFilteredNodes
            .filter(node => getMemoryGraphSearchHaystack(node).includes(query))
            .map(node => String(node.id)));
        for (const link of allLinks) {
            const source = String(link?.source || '');
            const target = String(link?.target || '');
            if (matchedIds.has(source) && typeFilteredIds.has(target)) {
                matchedIds.add(target);
            }
            if (matchedIds.has(target) && typeFilteredIds.has(source)) {
                matchedIds.add(source);
            }
        }
        candidateIds = matchedIds;
        if (mode !== 'timeline') {
            mode = 'search';
        }
    } else if (mode === 'focus') {
        candidateIds = new Set([selectedNodeId]);
        for (const link of allLinks) {
            const source = String(link?.source || '');
            const target = String(link?.target || '');
            if (source === selectedNodeId && typeFilteredIds.has(target)) {
                candidateIds.add(target);
            }
            if (target === selectedNodeId && typeFilteredIds.has(source)) {
                candidateIds.add(source);
            }
        }
    }

    const nodeLimit = mode === 'full' ? 120 : mode === 'timeline' ? 120 : mode === 'focus' ? 54 : mode === 'search' ? 72 : 36;
    const visibleNodes = typeFilteredNodes
        .filter(node => candidateIds.has(String(node.id)))
        .map((node, index) => ({
            node,
            score: getMemoryGraphNodeScore(node, degree.get(String(node.id)) || 0, index),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, nodeLimit)
        .map(item => item.node);
    const visibleIds = new Set(visibleNodes.map(node => String(node.id)));

    const linkLimit = mode === 'full' ? 180 : mode === 'overview' ? 80 : mode === 'timeline' ? 80 : 140;
    const visibleLinks = allLinks
        .filter((link) => {
            const source = String(link?.source || '');
            const target = String(link?.target || '');
            if (!visibleIds.has(source) || !visibleIds.has(target)) {
                return false;
            }
            if (String(link?.id || '') === selectedLinkId) {
                return true;
            }
            if (mode === 'focus' && (source === selectedNodeId || target === selectedNodeId)) {
                return true;
            }
            return clampNumber(link?.weight, 0.5, 0, 1) >= minWeight;
        })
        .map((link, index) => ({
            link,
            index,
            score: (String(link?.id || '') === selectedLinkId ? 10 : 0)
                + (mode === 'focus' && (String(link?.source || '') === selectedNodeId || String(link?.target || '') === selectedNodeId) ? 4 : 0)
                + clampNumber(link?.weight, 0.5, 0, 1),
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, linkLimit)
        .map(item => item.link);

    return {
        nodes: visibleNodes,
        links: visibleLinks,
        mode,
        query,
        minWeight,
        totalNodes: allNodes.length,
        totalLinks: allLinks.length,
        hiddenNodes: Math.max(0, allNodes.length - visibleNodes.length),
        hiddenLinks: Math.max(0, allLinks.length - visibleLinks.length),
    };
}

function renderMemoryGraphTypeFilters(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const types = [...new Set(nodes.map(node => String(node?.type || 'event')))]
        .sort((a, b) => getOptionLabel(MEMORY_NODE_TYPE_OPTIONS, a, a).localeCompare(getOptionLabel(MEMORY_NODE_TYPE_OPTIONS, b, b)));
    if (!types.length) {
        return '';
    }
    return `<div class="ai-wbr-memory-graph-typebar">
        ${types.map((type) => {
            const active = !(memoryGraphVisibleTypes instanceof Set) || memoryGraphVisibleTypes.size === 0 || memoryGraphVisibleTypes.has(type);
            const label = getOptionLabel(MEMORY_NODE_TYPE_OPTIONS, type, type);
            return `<button class="menu_button ai-wbr-memory-type-filter${active ? ' active' : ''}" type="button" data-memory-node-type="${escapeHtml(type)}">${escapeHtml(label)}</button>`;
        }).join('')}
    </div>`;
}

function getMemoryPreviewGroupKey(type) {
    const normalized = String(type || 'event').toLowerCase();
    if (normalized === 'character') return 'character';
    if (normalized === 'event' || normalized === 'quest') return 'event';
    if (normalized === 'location') return 'location';
    if (normalized === 'item') return 'item';
    if (normalized === 'faction' || normalized === 'concept' || normalized === 'rule') return 'setting';
    return 'other';
}

function getMemoryPreviewGroupLabel(group) {
    return ({
        character: '人物',
        event: '事件',
        location: '地点',
        item: '物品',
        setting: '设定',
        other: '其他',
    })[group] || group;
}

function renderMemoryPreviewPanel(graph, displayModel = buildMemoryGraphDisplayModel(graph)) {
    const panel = $('#ai_wbr_memory_preview_panel');
    if (!panel.length) {
        return;
    }
    const shell = panel.closest('.ai-wbr-graph-shell');
    const isOpen = shell.hasClass('preview-open');
    const selectedId = String(memoryGraphSelectedNodeId || '');
    const renderKey = [
        isOpen ? 'open' : 'closed',
        displayModel?.mode || '',
        displayModel?.query || '',
        selectedId,
        (displayModel?.nodes || []).map(node => `${node.id}:${node.updatedAt || ''}`).join('|'),
    ].join('::');
    if (!isOpen && panel.children().length && memoryGraphPreviewRenderKey === renderKey) {
        return;
    }
    if (!isOpen && panel.children().length) {
        memoryGraphPreviewRenderKey = renderKey;
        return;
    }
    if (memoryGraphPreviewRenderKey === renderKey) {
        return;
    }
    memoryGraphPreviewRenderKey = renderKey;

    const nodes = Array.isArray(displayModel?.nodes) ? displayModel.nodes : [];
    const links = Array.isArray(displayModel?.links) ? displayModel.links : [];
    const degree = new Map(nodes.map(node => [String(node.id), 0]));
    for (const link of links) {
        degree.set(String(link.source || ''), (degree.get(String(link.source || '')) || 0) + 1);
        degree.set(String(link.target || ''), (degree.get(String(link.target || '')) || 0) + 1);
    }

    const grouped = new Map();
    for (const node of nodes) {
        const group = getMemoryPreviewGroupKey(node.type);
        if (!grouped.has(group)) {
            grouped.set(group, []);
        }
        grouped.get(group).push(node);
    }

    const orderedGroups = ['character', 'event', 'location', 'item', 'setting', 'other'];
    const createCard = (node) => {
        const typeLabel = getOptionLabel(MEMORY_NODE_TYPE_OPTIONS, node.type, node.type || 'event');
        const summary = node.summary || node.content || '';
        const selected = String(node.id) === String(memoryGraphSelectedNodeId);
        const score = Math.round(clampNumber(node.importance, 0.5, 0, 1) * 100);
        const tags = uniqueStrings([...(Array.isArray(node.keys) ? node.keys : []), ...(Array.isArray(node.tags) ? node.tags : [])]).slice(0, 3);
        return $('<button class="ai-wbr-memory-preview-card" type="button"></button>')
            .toggleClass('selected', selected)
            .attr('data-memory-node-id', node.id)
            .append($('<b></b>').text(node.title || node.id))
            .append($('<small></small>').text(truncateText(summary, 96) || '暂无摘要'))
            .append($('<div class="ai-wbr-memory-preview-meta"></div>')
                .append($('<span></span>').text(typeLabel))
                .append($('<span></span>').text(`${score}% · ${degree.get(String(node.id)) || 0} 关系`)))
            .append(tags.length
                ? $('<div class="ai-wbr-memory-preview-tags"></div>').append(tags.map(tag => $('<span></span>').text(tag)))
                : '');
    };

    panel.empty().append(
        $('<div class="ai-wbr-memory-preview-head"></div>')
            .append($('<div></div>')
                .append($('<div class="ai-wbr-memory-preview-kicker"></div>').text('Memory Preview'))
                .append($('<div class="ai-wbr-memory-preview-title"></div>').text('记忆预览')))
            .append($('<div class="ai-wbr-memory-preview-count"></div>').text(`${nodes.length}/${displayModel.totalNodes || nodes.length}`)),
        $('<input class="text_pole ai-wbr-memory-preview-search" type="search" placeholder="搜索记忆、人物、地点、关键词" />').val(memoryGraphSearchText || ''),
    );

    if (!nodes.length) {
        panel.append($('<div class="ai-wbr-token-empty m-t-1"></div>').text('暂无可预览的记忆。清除筛选或继续生成后会显示。'));
        return;
    }

    for (const group of orderedGroups) {
        const groupNodes = (grouped.get(group) || [])
            .slice()
            .sort((a, b) => getMemoryGraphNodeScore(b, degree.get(String(b.id)) || 0) - getMemoryGraphNodeScore(a, degree.get(String(a.id)) || 0))
            .slice(0, 8);
        if (!groupNodes.length) {
            continue;
        }
        panel.append(
            $('<section class="ai-wbr-memory-preview-section"></section>')
                .append($('<div class="ai-wbr-memory-preview-section-title"></div>')
                    .append($('<span></span>').text(getMemoryPreviewGroupLabel(group)))
                    .append($('<small></small>').text(`${grouped.get(group).length}`)))
                .append($('<div class="ai-wbr-memory-preview-list"></div>').append(groupNodes.map(createCard))),
        );
    }
}

function applyMemoryGraphPreviewLayout(displayModel, canvasWidth, canvasHeight) {
    const nodes = Array.isArray(displayModel?.nodes) ? displayModel.nodes : [];
    const links = Array.isArray(displayModel?.links) ? displayModel.links : [];
    if (!nodes.length || displayModel.mode === 'full') {
        return false;
    }

    const isNarrow = canvasWidth < 760;
    const isMedium = canvasWidth >= 760 && canvasWidth < 1040;
    const padding = isNarrow ? 38 : MEMORY_GRAPH_LAYOUT_PADDING;
    const top = isNarrow ? 104 : Math.max(118, padding * 1.15);
    const availableWidth = Math.max(360, canvasWidth - padding * 2);
    const availableHeight = Math.max(260, canvasHeight - top - padding);
    const selectedId = String(memoryGraphSelectedNodeId || '');
    const nodeById = new Map(nodes.map(node => [String(node.id), node]));

    if (displayModel.mode === 'focus' && selectedId && nodeById.has(selectedId)) {
        const center = nodeById.get(selectedId);
        center.x = (canvasWidth - MEMORY_GRAPH_NODE_WIDTH) / 2;
        center.y = top + (availableHeight - MEMORY_GRAPH_NODE_HEIGHT) / 2;
        const neighbors = nodes.filter(node => String(node.id) !== selectedId);
        const innerIds = new Set();
        for (const link of links) {
            if (String(link.source) === selectedId) innerIds.add(String(link.target));
            if (String(link.target) === selectedId) innerIds.add(String(link.source));
        }
        const inner = neighbors.filter(node => innerIds.has(String(node.id)));
        const outer = neighbors.filter(node => !innerIds.has(String(node.id)));
        const placeRing = (items, radiusX, radiusY, startAngle = -Math.PI / 2) => {
            items.forEach((node, index) => {
                const angle = startAngle + (Math.PI * 2 * index / Math.max(1, items.length));
                node.x = (canvasWidth / 2) + Math.cos(angle) * radiusX - MEMORY_GRAPH_NODE_WIDTH / 2;
                node.y = (top + availableHeight / 2) + Math.sin(angle) * radiusY - MEMORY_GRAPH_NODE_HEIGHT / 2;
                const clamped = clampMemoryNodePosition(node.x, node.y, canvasWidth, canvasHeight, top);
                node.x = clamped.x;
                node.y = clamped.y;
            });
        };
        placeRing(inner, Math.min(availableWidth * (isNarrow ? 0.42 : 0.34), isNarrow ? 230 : 320), Math.min(availableHeight * 0.28, isNarrow ? 170 : 210));
        placeRing(outer, Math.min(availableWidth * (isNarrow ? 0.48 : 0.46), isNarrow ? 310 : 470), Math.min(availableHeight * 0.42, isNarrow ? 250 : 320), -Math.PI / 2 + 0.22);
        return true;
    }

    const groups = ['character', 'event', 'location', 'item', 'setting', 'other'];
    const buckets = new Map(groups.map(group => [group, []]));
    for (const node of nodes) {
        const group = getMemoryPreviewGroupKey(node.type);
        (buckets.get(group) || buckets.get('other')).push(node);
    }
    const activeGroups = groups.filter(group => buckets.get(group).length);
    const columns = Math.min(isNarrow ? 1 : isMedium ? 2 : 3, Math.max(1, activeGroups.length));
    const rows = Math.ceil(activeGroups.length / columns);
    const cellWidth = availableWidth / columns;
    const cellHeight = availableHeight / Math.max(1, rows);

    activeGroups.forEach((group, groupIndex) => {
        const col = groupIndex % columns;
        const row = Math.floor(groupIndex / columns);
        const items = buckets.get(group)
            .slice()
            .sort((a, b) => getMemoryGraphNodeScore(b) - getMemoryGraphNodeScore(a));
        const localColumns = Math.max(1, Math.floor(cellWidth / (MEMORY_GRAPH_NODE_WIDTH + (isNarrow ? 10 : 22))));
        items.forEach((node, index) => {
            const localCol = index % localColumns;
            const localRow = Math.floor(index / localColumns);
            node.x = padding + col * cellWidth + (isNarrow ? 4 : 14) + localCol * (MEMORY_GRAPH_NODE_WIDTH + (isNarrow ? 10 : 22));
            node.y = top + row * cellHeight + (isNarrow ? 10 : 16) + localRow * (MEMORY_GRAPH_NODE_HEIGHT + (isNarrow ? 16 : 24));
            const clamped = clampMemoryNodePosition(node.x, node.y, canvasWidth, canvasHeight, top);
            node.x = clamped.x;
            node.y = clamped.y;
        });
    });
    return true;
}

function isMemoryTimelineNode(node) {
    const type = String(node?.type || '').toLowerCase();
    return type === 'event' || type === 'quest' || !!node?.timeSpan;
}

function getMemoryTimelineGroupLabel(node) {
    const raw = String(node?.timeSpan || '').trim();
    if (raw) {
        return raw;
    }
    const dateText = String(node?.updatedAt || node?.createdAt || '').slice(0, 10);
    return dateText || '未标记时间';
}

function getMemoryTimelineSortValue(node, index = 0) {
    const timeText = String(node?.timeSpan || '').trim();
    const explicitNumber = Number(timeText.match(/\d+/)?.[0] || NaN);
    if (Number.isFinite(explicitNumber)) {
        return explicitNumber * 100000 + index;
    }
    const timestamp = Date.parse(node?.updatedAt || node?.createdAt || '');
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER - index;
}

function getMemoryTimelineRelatedNodes(graph, node, typeNames = []) {
    const wanted = new Set(typeNames.map(type => String(type).toLowerCase()));
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const links = Array.isArray(graph?.links) ? graph.links : [];
    const nodeById = new Map(nodes.map(item => [String(item.id), item]));
    const related = [];
    for (const link of links) {
        const source = String(link?.source || '');
        const target = String(link?.target || '');
        const otherId = source === String(node.id) ? target : target === String(node.id) ? source : '';
        if (!otherId) {
            continue;
        }
        const other = nodeById.get(otherId);
        if (!other) {
            continue;
        }
        if (!wanted.size || wanted.has(String(other.type || '').toLowerCase())) {
            related.push(other);
        }
    }
    return related;
}

function renderMemoryGraphToolbarHtml(graph, displayModel, nodes, edges) {
    const fullscreenLabel = memoryGraphFullscreenActive ? '退出全屏' : '全屏图谱';
    return `
        <div class="ai-wbr-memory-graph-toolbar">
            <div class="ai-wbr-memory-graph-row">
                <button class="menu_button ai-wbr-memory-mode ${displayModel.mode === 'overview' ? 'active' : ''}" type="button" data-memory-graph-mode="overview">概览</button>
                <button class="menu_button ai-wbr-memory-mode ${displayModel.mode === 'focus' ? 'active' : ''}" type="button" data-memory-graph-mode="focus" ${memoryGraphSelectedNodeId ? '' : 'disabled'}>聚焦</button>
                <button class="menu_button ai-wbr-memory-mode ${displayModel.mode === 'timeline' ? 'active' : ''}" type="button" data-memory-graph-mode="timeline">时间线</button>
                <button class="menu_button ai-wbr-memory-mode ${displayModel.mode === 'full' ? 'active' : ''}" type="button" data-memory-graph-mode="full">全量</button>
                <button class="menu_button ai-wbr-memory-clear-filters" type="button">清除筛选</button>
            </div>
            <div class="ai-wbr-memory-graph-row">
                <input class="text_pole ai-wbr-memory-graph-search" type="search" placeholder="搜索人物、地点、事件、关键词" value="${escapeHtml(memoryGraphSearchText)}" />
                <label class="ai-wbr-memory-weight-filter">关系≥<span>${Math.round(displayModel.minWeight * 100)}%</span><input class="ai-wbr-memory-link-weight" type="range" min="0" max="1" step="0.05" value="${displayModel.minWeight}" /></label>
            </div>
            ${renderMemoryGraphTypeFilters(graph)}
            <div class="ai-wbr-memory-graph-row ai-wbr-memory-graph-statusbar">
                <div class="ai-wbr-memory-graph-summary">显示 ${nodes.length}/${displayModel.totalNodes} 节点，${edges.length}/${displayModel.totalLinks} 关系${displayModel.hiddenNodes || displayModel.hiddenLinks ? `，已收起 ${displayModel.hiddenNodes} 节点 / ${displayModel.hiddenLinks} 关系` : ''}</div>
                <button class="menu_button ai-wbr-memory-zoom-in" type="button">＋</button>
                <button class="menu_button ai-wbr-memory-zoom-out" type="button">－</button>
                <button class="menu_button ai-wbr-memory-zoom-reset" type="button">适配视图</button>
                <button class="menu_button ai-wbr-memory-open-fullscreen" type="button">${fullscreenLabel}</button>
                <span class="ai-wbr-memory-link-hint">${memoryGraphLinkSourceId ? `连线起点：${escapeHtml(graph.nodes.find(node => node.id === memoryGraphLinkSourceId)?.title || memoryGraphLinkSourceId)}` : ''}</span>
            </div>
        </div>
    `;
}

function setMemoryGraphFullscreen(enabled, options = {}) {
    const section = $('#ai_wbr_memory_graph_section');
    if (!section.length) {
        return;
    }
    memoryGraphFullscreenActive = !!enabled;
    section.toggleClass('ai-wbr-memory-graph-fullscreen', memoryGraphFullscreenActive);
    $('body').toggleClass('ai-wbr-memory-graph-fullscreen-open', memoryGraphFullscreenActive);
    $('#ai_wbr_memory_graph_fullscreen').text(memoryGraphFullscreenActive ? '退出全屏' : '全屏图谱');
    if (memoryGraphFullscreenActive) {
        section.closest('.ai-wbr-graph-shell').removeClass('preview-open');
    }
    const shouldFit = options.fit !== false;
    requestAnimationFrame(() => {
        if (shouldFit) {
            fitMemoryGraphToContainer(getMemoryGraph());
        }
        renderMemoryPanel('graph');
    });
}

function openMemoryGraphCanvasFullscreen() {
    const openConsole = globalThis.aiWbrOpenConsole;
    if (typeof openConsole === 'function' && !$('#ai_wbr_memory_graph_section').is(':visible')) {
        openConsole('graph', { mode: 'floating' });
    }
    setTimeout(() => setMemoryGraphFullscreen(true), 80);
    setTimeout(() => setMemoryGraphFullscreen(true), 240);
}

function renderMemoryTimelineView(graph, displayModel) {
    const container = $('#ai_wbr_memory_graph');
    const nodes = Array.isArray(displayModel?.nodes) ? displayModel.nodes : [];
    const eventNodes = nodes
        .filter(isMemoryTimelineNode)
        .map((node, index) => ({ node, index, sortValue: getMemoryTimelineSortValue(node, index) }))
        .sort((a, b) => a.sortValue - b.sortValue || a.index - b.index)
        .map(item => item.node);
    const edges = Array.isArray(displayModel?.links) ? displayModel.links : [];
    const grouped = new Map();
    for (const node of eventNodes) {
        const label = getMemoryTimelineGroupLabel(node);
        if (!grouped.has(label)) {
            grouped.set(label, []);
        }
        grouped.get(label).push(node);
    }

    const groupsHtml = eventNodes.length
        ? [...grouped.entries()].map(([label, items]) => `
            <section class="ai-wbr-memory-timeline-group">
                <div class="ai-wbr-memory-timeline-group-title">${escapeHtml(label)} <span>${items.length}</span></div>
                <div class="ai-wbr-memory-timeline-items">
                    ${items.map((node) => {
                        const people = getMemoryTimelineRelatedNodes(graph, node, ['character']).slice(0, 4);
                        const locations = getMemoryTimelineRelatedNodes(graph, node, ['location']).slice(0, 2);
                        const settings = getMemoryTimelineRelatedNodes(graph, node, ['item', 'concept', 'rule', 'faction']).slice(0, 4);
                        const selected = String(node.id) === String(memoryGraphSelectedNodeId);
                        const chips = [
                            ...people.map(item => `人物：${item.title || item.id}`),
                            ...locations.map(item => `地点：${item.title || item.id}`),
                            ...settings.map(item => getOptionLabel(MEMORY_NODE_TYPE_OPTIONS, item.type, item.type || '设定') + `：${item.title || item.id}`),
                        ].slice(0, 6);
                        return `
                            <button class="ai-wbr-memory-timeline-card${selected ? ' selected' : ''}" type="button" data-memory-node-id="${escapeHtml(node.id)}">
                                <span class="ai-wbr-memory-timeline-dot"></span>
                                <span class="ai-wbr-memory-timeline-card-body">
                                    <b>${escapeHtml(node.title || node.id)}</b>
                                    <small>${escapeHtml(truncateText(node.summary || node.content || '暂无摘要', 160))}</small>
                                    <span class="ai-wbr-memory-timeline-meta">
                                        ${escapeHtml(node.location || locations[0]?.title || '地点未标记')}
                                        ${node.updatedAt ? ` · ${escapeHtml(String(node.updatedAt).slice(0, 10))}` : ''}
                                    </span>
                                    ${chips.length ? `<span class="ai-wbr-memory-timeline-chips">${chips.map(chip => `<i>${escapeHtml(chip)}</i>`).join('')}</span>` : ''}
                                </span>
                            </button>
                        `;
                    }).join('')}
                </div>
            </section>
        `).join('')
        : '<div class="ai-wbr-token-empty ai-wbr-memory-timeline-empty">暂无事件时间线。事件/任务节点，或带有时间字段的记忆，会显示在这里。</div>';

    container.html(`
        ${renderMemoryGraphToolbarHtml(graph, displayModel, eventNodes, edges)}
        <div class="ai-wbr-memory-timeline-view">
            <div class="ai-wbr-memory-timeline-head">
                <div>
                    <div class="ai-wbr-memory-detail-kicker">Timeline</div>
                    <h3>剧情时间线</h3>
                </div>
                <small>按时间、章节或更新时间排列事件节点</small>
            </div>
            <div class="ai-wbr-memory-timeline-rail">${groupsHtml}</div>
        </div>
    `);
    bindMemoryGraphSvgInteractions();
}

function renderMemoryDetailDrawer(graph = getMemoryGraph()) {
    const drawer = $('#ai_wbr_memory_detail_drawer');
    if (!drawer.length) {
        return;
    }

    const createMeta = (label, value) => $('<div class="ai-wbr-memory-detail-meta"></div>')
        .append($('<span></span>').text(label))
        .append($('<b></b>').text(value || '未记录'));
    const createChips = (items) => {
        const chips = $('<div class="ai-wbr-memory-detail-chips"></div>');
        for (const item of uniqueStrings(items || []).slice(0, 12)) {
            chips.append($('<span></span>').text(item));
        }
        return chips.children().length ? chips : $('<div class="ai-wbr-memory-detail-muted"></div>').text('暂无');
    };

    const selectedLink = memoryGraphDetailMode === 'link'
        ? graph.links.find(link => String(link.id) === String(memoryGraphSelectedLinkId))
        : null;
    if (selectedLink) {
        const source = graph.nodes.find(node => node.id === selectedLink.source);
        const target = graph.nodes.find(node => node.id === selectedLink.target);
        drawer.empty().addClass('open').append(
            $('<div class="ai-wbr-memory-detail-head"></div>')
                .append($('<div></div>')
                    .append($('<div class="ai-wbr-memory-detail-kicker"></div>').text('关系详情'))
                    .append($('<h3></h3>').text(`${source?.title || selectedLink.source} → ${target?.title || selectedLink.target}`)))
                .append($('<button class="menu_button ai-wbr-memory-detail-close" type="button">关闭</button>')),
            $('<div class="ai-wbr-memory-detail-grid"></div>')
                .append(createMeta('关系类型', getOptionLabel(MEMORY_LINK_TYPE_OPTIONS, selectedLink.type, selectedLink.type || 'RELATED')))
                .append(createMeta('权重', String(selectedLink.weight ?? 0.7)))
                .append(createMeta('更新时间', selectedLink.updatedAt || graph.updatedAt || '')),
            $('<div class="ai-wbr-memory-detail-section"></div>')
                .append($('<b></b>').text('关系说明'))
                .append($('<p></p>').text(selectedLink.description || '暂无关系说明。')),
            $('<div class="ai-wbr-memory-detail-actions"></div>')
                .append($('<button class="menu_button ai-wbr-memory-detail-delete-link" type="button">删除这条关系</button>').attr('data-memory-link-id', selectedLink.id)),
        );
        return;
    }

    const selectedNode = memoryGraphDetailMode === 'node'
        ? graph.nodes.find(node => node.id === memoryGraphSelectedNodeId)
        : null;
    if (selectedNode) {
        const typeLabel = getOptionLabel(MEMORY_NODE_TYPE_OPTIONS, selectedNode.type, selectedNode.type || 'event');
        const relatedLinks = graph.links.filter(link => link.source === selectedNode.id || link.target === selectedNode.id);
        const sourceTitle = memoryGraphLinkSourceId
            ? graph.nodes.find(node => node.id === memoryGraphLinkSourceId)?.title || memoryGraphLinkSourceId
            : '';
        const canLinkToSource = memoryGraphLinkSourceId && memoryGraphLinkSourceId !== selectedNode.id;
        const hasRelatedLink = !!(canLinkToSource && graph.links.some(item => item.source === memoryGraphLinkSourceId && item.target === selectedNode.id && item.type === 'RELATED'));

        const relatedList = $('<div class="ai-wbr-memory-detail-related"></div>');
        if (relatedLinks.length) {
            for (const link of relatedLinks.slice(0, 10)) {
                const otherId = link.source === selectedNode.id ? link.target : link.source;
                const other = graph.nodes.find(node => node.id === otherId);
                relatedList.append($('<button class="menu_button ai-wbr-memory-detail-related-link" type="button"></button>')
                    .attr('data-memory-link-id', link.id)
                    .text(`${getOptionLabel(MEMORY_LINK_TYPE_OPTIONS, link.type, link.type || 'RELATED')}：${other?.title || otherId}`));
            }
        } else {
            relatedList.append($('<div class="ai-wbr-memory-detail-muted"></div>').text('暂无关联关系。'));
        }

        drawer.empty().addClass('open').append(
            $('<div class="ai-wbr-memory-detail-head"></div>')
                .append($('<div></div>')
                    .append($('<div class="ai-wbr-memory-detail-kicker"></div>').text(typeLabel))
                    .append($('<h3></h3>').text(selectedNode.title || selectedNode.id)))
                .append($('<button class="menu_button ai-wbr-memory-detail-close" type="button">关闭</button>')),
            $('<div class="ai-wbr-memory-detail-grid"></div>')
                .append(createMeta('重要度', `${Math.round(clampNumber(selectedNode.importance, 0.5, 0, 1) * 100)}%`))
                .append(createMeta('可信度', `${Math.round(clampNumber(selectedNode.credibility, 0.8, 0, 1) * 100)}%`))
                .append(createMeta('地点', selectedNode.location || ''))
                .append(createMeta('时间', selectedNode.timeSpan || ''))
                .append(createMeta('更新时间', selectedNode.updatedAt || graph.updatedAt || '')),
            $('<div class="ai-wbr-memory-detail-section"></div>')
                .append($('<b></b>').text('摘要'))
                .append($('<p></p>').text(selectedNode.summary || selectedNode.content || '暂无摘要。')),
            $('<div class="ai-wbr-memory-detail-section"></div>')
                .append($('<b></b>').text('详细内容'))
                .append($('<p></p>').text(selectedNode.content || selectedNode.summary || '暂无详细内容。')),
            $('<div class="ai-wbr-memory-detail-section"></div>')
                .append($('<b></b>').text('关键词'))
                .append(createChips(selectedNode.keys)),
            $('<div class="ai-wbr-memory-detail-section"></div>')
                .append($('<b></b>').text('标签'))
                .append(createChips(selectedNode.tags)),
            $('<div class="ai-wbr-memory-detail-section"></div>')
                .append($('<b></b>').text('关联关系'))
                .append(relatedList),
            $('<div class="ai-wbr-memory-detail-actions"></div>')
                .append($('<button class="menu_button ai-wbr-memory-detail-set-link-source" type="button">设为连线起点</button>').attr('data-memory-node-id', selectedNode.id))
                .append($(`<button class="menu_button ai-wbr-memory-detail-link-to-source" type="button" ${canLinkToSource ? '' : 'disabled'}>${hasRelatedLink ? '取消连接到起点' : '连接到起点'}${sourceTitle ? `：${escapeHtml(truncateText(sourceTitle, 10))}` : ''}</button>`).attr('data-memory-node-id', selectedNode.id))
                .append($('<button class="menu_button ai-wbr-memory-detail-delete-node" type="button">删除节点</button>').attr('data-memory-node-id', selectedNode.id)),
        );
        return;
    }

    drawer.removeClass('open').html('<div class="ai-wbr-memory-detail-empty">点击图谱中的记忆卡片或关系线查看详情。</div>');
}

function renderMemoryGraphSvg(graph) {
    const container = $('#ai_wbr_memory_graph');
    if (!container.length) {
        return;
    }

    graph = graph && typeof graph === 'object' ? graph : getDefaultMemoryGraph();
    graph.nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    graph.links = Array.isArray(graph.links) ? graph.links : [];

    let displayModel = buildMemoryGraphDisplayModel(graph);
    if (!displayModel.nodes.length && graph.nodes.length) {
        memoryGraphSearchText = '';
        memoryGraphVisibleTypes = new Set();
        if (memoryGraphDisplayMode === 'search' || memoryGraphDisplayMode === 'focus') {
            memoryGraphDisplayMode = 'overview';
        }
        displayModel = buildMemoryGraphDisplayModel(graph);
    }
    renderMemoryPreviewPanel(graph, displayModel);
    if (displayModel.mode === 'timeline') {
        renderMemoryTimelineView(graph, displayModel);
        return;
    }
    const nodes = displayModel.nodes;
    if (!nodes.length) {
        container.html(`
            ${renderMemoryGraphToolbarHtml(graph, displayModel, [], [])}
            <div class="ai-wbr-memory-graph-canvas ai-wbr-memory-graph-empty">
                <div class="ai-wbr-token-empty">暂无可显示的记忆节点。可以清除搜索/类型筛选，或生成回复后让记忆图谱继续整理。</div>
            </div>
        `);
        bindMemoryGraphSvgInteractions();
        return;
    }

    const viewport = getMemoryGraphViewportMetrics(container[0]);
    const width = viewport.layoutWidth;
    const height = viewport.layoutHeight;
    const positions = new Map();
    const usedPreviewLayout = applyMemoryGraphPreviewLayout(displayModel, width, height);
    let layoutChanged = false;
    if (!usedPreviewLayout) {
        layoutChanged = normalizeMemoryGraphLayout(nodes, displayModel.links, width, height);
    }
    nodes.forEach((node) => {
        positions.set(node.id, {
            x: Number(node.x || 0),
            y: Number(node.y || 0),
        });
    });

    if (layoutChanged) {
        saveMemoryGraph(graph, getContext(), true);
    }

    const edges = displayModel.links;
    const pairBuckets = new Map();
    edges.forEach((link) => {
        const pairKey = [String(link.source || ''), String(link.target || '')].sort().join('||');
        if (!pairBuckets.has(pairKey)) {
            pairBuckets.set(pairKey, []);
        }
        pairBuckets.get(pairKey).push(link);
    });
    const markerDefs = `
        <defs>
            <marker id="ai-wbr-memory-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M 0 0 L 8 4 L 0 8 z" class="ai-wbr-memory-arrow"></path>
            </marker>
        </defs>
    `;
    const lines = edges.map(link => {
        const source = positions.get(link.source);
        const target = positions.get(link.target);
        if (!source || !target) {
            return '';
        }
        const opacity = Math.max(0.22, Math.min(0.85, Number(link.weight || 0.5)));
        const selectedClass = String(link.id) === String(memoryGraphSelectedLinkId) ? ' ai-wbr-memory-edge-selected' : '';
        const typeClass = ` ai-wbr-memory-edge-${escapeHtml(String(link.type || 'RELATED').toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}`;
        const pairKey = [String(link.source || ''), String(link.target || '')].sort().join('||');
        const siblings = (pairBuckets.get(pairKey) || []).slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
        const siblingIndex = siblings.findIndex(item => String(item.id || '') === String(link.id || ''));
        const offsetIndex = siblingIndex - ((siblings.length - 1) / 2);
        const laneOffset = siblings.length > 1 ? offsetIndex * 26 : 0;
        const path = buildMemoryEdgePath(source, target, laneOffset);
        const linkId = escapeHtml(String(link.id || ''));
        return `
            <path d="${path}" class="ai-wbr-memory-edge-hit" data-memory-link-id="${linkId}" data-source-id="${escapeHtml(link.source)}" data-target-id="${escapeHtml(link.target)}"></path>
            <path d="${path}" class="ai-wbr-memory-edge${typeClass}${selectedClass}" data-memory-link-id="${linkId}" data-source-id="${escapeHtml(link.source)}" data-target-id="${escapeHtml(link.target)}" style="opacity:${opacity}" marker-end="url(#ai-wbr-memory-arrow)"><title>${escapeHtml(getOptionLabel(MEMORY_LINK_TYPE_OPTIONS, link.type, link.type || 'RELATED'))}</title></path>
        `;
    }).join('');

    const cards = nodes.map(node => {
        const position = positions.get(node.id);
        const rawType = String(node.type || 'event');
        const colorClass = `ai-wbr-memory-node-${escapeHtml(rawType.toLowerCase())}`;
        const typeLabel = getOptionLabel(MEMORY_NODE_TYPE_OPTIONS, rawType, rawType);
        const subtitle = node.summary || node.content || '';
        const selectedClass = String(node.id) === String(memoryGraphSelectedNodeId) ? ' ai-wbr-memory-node-selected' : '';
        const searchClass = displayModel.query && getMemoryGraphSearchHaystack(node).includes(displayModel.query) ? ' ai-wbr-memory-node-search-hit' : '';
        const importanceLabel = `${Math.round(clampNumber(node.importance, 0.5, 0, 1) * 100)}%`;
        return `<g class="ai-wbr-memory-node ${colorClass}${selectedClass}${searchClass}" data-memory-node-id="${escapeHtml(node.id)}" transform="translate(${position.x},${position.y})">
            <rect class="ai-wbr-memory-node-card" x="0" y="0" width="${MEMORY_GRAPH_NODE_WIDTH}" height="${MEMORY_GRAPH_NODE_HEIGHT}" rx="14" ry="14"></rect>
            <circle class="ai-wbr-memory-node-accent" cx="16" cy="16" r="4"></circle>
            <text class="ai-wbr-memory-node-title" x="28" y="21">${escapeHtml(truncateText(node.title || node.id, 20))}</text>
            <text class="ai-wbr-memory-node-subtitle" x="14" y="42">${escapeHtml(truncateText(subtitle, 32) || '暂无摘要')}</text>
            <g class="ai-wbr-memory-node-badge" transform="translate(12,56)">
                <rect width="${Math.max(34, typeLabel.length * 12)}" height="18" rx="9" ry="9"></rect>
                <text x="${Math.max(34, typeLabel.length * 12) / 2}" y="12">${escapeHtml(typeLabel)}</text>
            </g>
            <text class="ai-wbr-memory-node-score" x="154" y="68">${escapeHtml(importanceLabel)}</text>
            <title>${escapeHtml(`${node.title}\n${node.content || ''}`)}</title>
        </g>`;
    }).join('');

    if (!memoryGraphView
        || !Number.isFinite(memoryGraphView.x)
        || !Number.isFinite(memoryGraphView.y)
        || !Number.isFinite(memoryGraphView.width)
        || !Number.isFinite(memoryGraphView.height)
        || memoryGraphView.width < 120
        || memoryGraphView.height < 80) {
        fitMemoryGraphToNodes(nodes, container[0]);
    }
    syncMemoryGraphViewToContainerAspect(container[0]);

    container.html(`
        ${renderMemoryGraphToolbarHtml(graph, displayModel, nodes, edges)}
        <div class="ai-wbr-memory-graph-canvas">
            <svg viewBox="${memoryGraphView.x} ${memoryGraphView.y} ${memoryGraphView.width} ${memoryGraphView.height}" preserveAspectRatio="none" role="img" aria-label="记忆图谱">${markerDefs}${lines}${cards}</svg>
        </div>
    `);
    bindMemoryGraphSvgInteractions();
}

function renderMemoryDashboard(graph) {
    const dashboard = $('#ai_wbr_memory_dashboard').empty();
    if (!dashboard.length) {
        return;
    }

    const queueCount = getMemoryReviewQueue().length;
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const links = Array.isArray(graph?.links) ? graph.links : [];
    const nodeTypes = nodes.reduce((acc, node) => {
        const type = String(node.type || 'memory');
        acc[type] = (acc[type] || 0) + 1;
        return acc;
    }, {});
    const topType = Object.entries(nodeTypes).sort((a, b) => b[1] - a[1])[0];
    const activeTopics = Array.isArray(graph?.state?.active_topics)
        ? graph.state.active_topics.slice(0, 3).join('，')
        : '';
    const cards = [
        ['记忆节点', String(nodes.length), topType ? `最多：${topType[0]} × ${topType[1]}` : '等待写入'],
        ['关系边', String(links.length), graph.updatedAt ? `更新：${new Date(graph.updatedAt).toLocaleString()}` : '暂无关系'],
        ['待确认', String(queueCount), queueCount ? 'AI 更新等待确认' : '没有待处理更新'],
        ['当前主题', activeTopics || '未识别', graph.lastSummary ? truncateText(graph.lastSummary, 64) : '等待整理剧情'],
    ];

    for (const [label, value, note] of cards) {
        dashboard.append(
            $('<div class="ai-wbr-memory-metric"></div>')
                .append($('<div class="ai-wbr-memory-metric-label"></div>').text(label))
                .append($('<div class="ai-wbr-memory-metric-value"></div>').text(value))
                .append($('<div class="ai-wbr-memory-metric-note"></div>').text(note)),
        );
    }
}

function renderMemoryReviewQueue() {
    const container = $('#ai_wbr_memory_review_queue').empty();
    if (!container.length) {
        return;
    }

    const queue = getMemoryReviewQueue();
    const reviewFold = $('.ai-wbr-memory-review-fold');
    $('#ai_wbr_memory_review_badge').text(queue.length ? `${queue.length} 条待确认，建议先处理。` : '暂无待确认。');
    reviewFold.toggleClass('ai-wbr-memory-fold-attention', queue.length > 0);
    if (queue.length) {
        reviewFold.prop('open', true);
    }

    container.append($('<div class="ai-wbr-memory-subtitle"><b>待确认记忆更新</b></div>'));
    if (!queue.length) {
        container.append('<div class="ai-wbr-token-empty">暂无待确认更新。开启“记忆更新需要确认”后，AI 整理结果会先出现在这里。</div>');
        return;
    }

    for (const item of queue) {
        const summary = item.summary || summarizeMemoryUpdateProposal(item.update);
        const sourceLabel = getMemorySourceLabel(item.source);
        const sourceInvalidated = item.source?.id && getInvalidatedMemorySourceIds(item.source.chatKey || getCurrentChatMemoryKey()).includes(String(item.source.id));
        const isStale = item.status === 'stale' || sourceInvalidated || (item.source?.chatKey && item.source.chatKey !== getCurrentChatMemoryKey());
        const chips = [
            `新增 ${summary.nodes || 0}`,
            `修改 ${summary.updates || 0}`,
            `关系 ${summary.links || 0}`,
            `状态 ${summary.stateChanges || 0}`,
            sourceLabel ? `来源 ${sourceLabel}` : '',
            isStale ? '已失效' : '',
            summary.removes ? `删除 ${summary.removes}` : '',
        ].filter(Boolean);

        container.append(
            $('<div class="ai-wbr-memory-review-card"></div>')
                .toggleClass('ai-wbr-memory-review-card-stale', isStale)
                .attr('data-memory-review-id', item.id)
                .append($('<div class="ai-wbr-memory-review-head"></div>')
                    .append($('<div></div>')
                        .append($('<b></b>').text(item.title || '待确认记忆更新'))
                        .append($('<small></small>').text(` ${item.reason || 'auto'} · ${item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}${sourceLabel ? ` · ${sourceLabel}` : ''}${isStale ? ' · roll/swipe 后已失效' : ''}`)))
                    .append($('<div class="ai-wbr-memory-review-actions"></div>')
                        .append($('<button class="menu_button ai-wbr-memory-review-accept" type="button">确认写入</button>').prop('disabled', isStale))
                        .append('<button class="menu_button ai-wbr-memory-review-reject" type="button">忽略</button>')))
                .append($('<div class="ai-wbr-memory-review-chips"></div>').append(chips.map(chip => $('<span></span>').text(chip))))
                .append($('<div class="ai-wbr-memory-review-summary"></div>').text(item.update?.summary || '无摘要')),
        );
    }
}

function getBookshelfTypeLabel(type) {
    return ({
        character: '人物档案',
        world: '世界观',
        plot: '剧情记录',
        rule: '规则设定',
        memory: '自动记忆书',
        other: '其他资料',
    })[String(type || 'other')] || '其他资料';
}

function getBookshelfStatusLabel(book) {
    if (!book) return '未知';
    if (book.enabled === false) return '已禁用';
    if (book.status === 'empty') return '无片段';
    if (book.status === 'vectorizing') return `向量化中 ${book.vectorizedCount || 0}/${book.chunkCount || 0}`;
    if (book.status === 'failed') return '向量化失败';
    if (book.status === 'partial_failed') return `部分完成 ${book.vectorizedCount || 0}/${book.chunkCount || 0}`;
    if (Number(book.vectorizedCount || 0) > 0 && Number(book.vectorizedCount || 0) >= Number(book.chunkCount || 0)) return '已向量化';
    return '待向量化';
}

function getBookshelfBindingLabels(book) {
    const labels = normalizeBookshelfBindings(book).map(item => {
        if (item.type === 'character') return `角色：${item.label || '当前角色'}`;
        if (item.type === 'chat') return `聊天：${item.label || '当前聊天'}`;
        if (item.type === 'global') return '全局';
        return item.label || item.type;
    });
    return labels.length ? labels : ['未绑定'];
}

function createBookshelfBookCard(book, selected) {
    const isAutoMemoryBook = book?.autoGenerated && book?.autoSource === 'memory-graph';
    const modeLabel = book.embeddingMode
        ? `${book.embeddingMode}${book.embeddingModel ? ` / ${book.embeddingModel}` : ''}${book.embeddingDim ? ` / ${book.embeddingDim}维` : ''}`
        : '待向量化';
    const progress = Number(book.chunkCount || 0)
        ? Math.round((Number(book.vectorizedCount || 0) / Number(book.chunkCount || 1)) * 100)
        : 0;
    const badge = book.enabled === false ? '停用' : Number(book.vectorizedCount || 0) ? '已向量' : '待向量';
    return $('<div class="ai-wbr-bookshelf-book"></div>')
        .toggleClass('selected', !!selected)
        .toggleClass('ai-wbr-bookshelf-memory-book', !!isAutoMemoryBook)
        .attr('data-bookshelf-book-id', book.id)
        .append(
            $('<button class="ai-wbr-bookshelf-cover ai-wbr-bookshelf-select" type="button"></button>')
                .append($('<span class="ai-wbr-bookshelf-cover-badge"></span>').text(badge))
                .append(isAutoMemoryBook ? $('<span class="ai-wbr-bookshelf-cover-mark"></span>').text('记忆小说') : null)
                .append($('<b></b>').text(book.title || book.fileName || '未命名'))
                .append($('<small></small>').text(getBookshelfTypeLabel(book.type))),
            $('<div class="ai-wbr-bookshelf-book-title"></div>').text(book.title || book.fileName || '未命名'),
            $('<div class="ai-wbr-bookshelf-book-meta"></div>').text(`${book.chunkCount || 0} 段 · ${progress}% · ${getBookshelfStatusLabel(book)}`),
            $('<div class="ai-wbr-bookshelf-book-provider"></div>').text(modeLabel),
        );
}

function renderBookshelfResults(container, results = []) {
    container.empty();
    if (!results.length) {
        container.append('<div class="ai-wbr-token-empty">暂无召回结果。输入一句话后点“测试召回”。</div>');
        return;
    }
    for (const item of results) {
        const isMemoryVector = item.source === 'memory-vector';
        const title = isMemoryVector
            ? `图谱记忆 / ${item.comment || item.title || item.uid || '记忆节点'}`
            : `《${item.book?.title || item.book?.fileName || '书架'}》 / ${item.title || `片段 ${item.order || ''}`}`;
        container.append(
            $('<div class="ai-wbr-bookshelf-result"></div>')
                .append($('<div class="ai-wbr-bookshelf-result-head"></div>')
                    .append($('<b></b>').text(title))
                    .append($('<span></span>').text(`分数 ${Number(item.score || 0).toFixed(2)}`)))
                .append($('<small></small>').text(`语义 ${Number(item.semanticScore || 0).toFixed(2)} · 关键词 ${Number(item.keywordScore || 0).toFixed(2)}`))
                .append($('<p></p>').text(truncateText(item.text || item.content || '', 420))),
        );
    }
}

function buildBookshelfNovelParts(book, chunks = []) {
    const selectedChunks = (chunks || []).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    const chapters = [];
    const chapterSeen = new Set();
    for (const chapter of Array.isArray(book?.chapters) ? book.chapters : []) {
        const title = String(chapter?.title || '').trim();
        if (title && !chapterSeen.has(title)) {
            chapterSeen.add(title);
            chapters.push({ title, count: Number(chapter.count || 0) });
        }
    }
    for (const chunk of selectedChunks) {
        const title = String(chunk.chapterTitle || '正文目录').trim();
        if (!chapterSeen.has(title)) {
            chapterSeen.add(title);
            chapters.push({ title, count: selectedChunks.filter(item => String(item.chapterTitle || '正文目录') === title).length });
        }
    }
    return {
        chunks: selectedChunks,
        chapters: chapters.length ? chapters : [{ title: '正文目录', count: selectedChunks.length }],
    };
}

function createBookshelfNovelReader(book, chunks = []) {
    const { chapters, chunks: selectedChunks } = buildBookshelfNovelParts(book, chunks);
    const overlay = $('<div class="ai-wbr-bookshelf-reader-overlay" role="dialog" aria-modal="true"></div>');
    const pages = $('<main class="ai-wbr-bookshelf-reader-pages"></main>').append(
        selectedChunks.slice(0, 160).map(chunk => (
            $('<article class="ai-wbr-bookshelf-reader-page"></article>')
                .toggleClass('disabled', chunk.enabled === false)
                .attr('data-bookshelf-chapter-title', chunk.chapterTitle || '正文目录')
                .append($('<div class="ai-wbr-bookshelf-reader-page-head"></div>')
                    .append($('<b></b>').text(chunk.title || `第 ${chunk.order || ''} 节`))
                    .append($('<span></span>').text(chunk.vectorStatus === 'ready' ? '已向量化' : chunk.vectorStatus === 'failed' ? '向量失败' : '待向量化')))
                .append($('<p></p>').text(chunk.text || ''))
        )),
    );
    overlay.append(
        $('<div class="ai-wbr-bookshelf-reader-shell"></div>')
            .append(
                $('<header class="ai-wbr-bookshelf-reader-top"></header>')
                    .append(
                        $('<div></div>')
                            .append($('<b></b>').text(book.title || book.fileName || '记忆书'))
                            .append($('<small></small>').text(`${chapters.length} 章 · ${selectedChunks.length} 小节 · 当前聊天记忆书`)),
                    )
                    .append($('<button class="menu_button ai-wbr-bookshelf-reader-close" type="button">关闭</button>')),
                $('<section class="ai-wbr-bookshelf-reader-hero"></section>')
                    .append(
                        $('<div class="ai-wbr-bookshelf-reader-cover"></div>')
                            .append($('<span></span>').text('记忆小说'))
                            .append($('<strong></strong>').text(book.title || '记忆书'))
                            .append($('<small></small>').text(`${book.vectorizedCount || 0}/${book.chunkCount || 0} 已向量化`)),
                        $('<div class="ai-wbr-bookshelf-reader-intro"></div>')
                            .append($('<h3></h3>').text(book.title || '记忆书'))
                            .append($('<p></p>').text(book.sourceSummary || '从当前聊天图谱自动整理，按小说目录阅读，也可参与向量召回。'))
                            .append($('<div class="ai-wbr-bookshelf-novel-stats"></div>')
                                .append($('<span></span>').text(`章节 ${chapters.length}`))
                                .append($('<span></span>').text(`小节 ${selectedChunks.length}`))
                                .append($('<span></span>').text(`向量 ${book.vectorizedCount || 0}/${book.chunkCount || 0}`))),
                    ),
                $('<section class="ai-wbr-bookshelf-reader-body"></section>')
                    .append(
                        $('<aside class="ai-wbr-bookshelf-reader-toc"></aside>')
                            .append($('<b></b>').text('目录'))
                            .append(chapters.map((chapter, index) => (
                                $('<button class="ai-wbr-bookshelf-reader-toc-item" type="button"></button>')
                                    .attr('data-bookshelf-chapter-title', chapter.title)
                                    .toggleClass('active', index === 0)
                                    .append($('<span></span>').text(chapter.title))
                                    .append($('<small></small>').text(`${chapter.count || 0} 节`))
                            ))),
                        pages,
                    ),
            ),
    );
    return overlay;
}

async function openBookshelfNovelReader(bookId) {
    const [book, chunks] = await Promise.all([
        bookshelfGet('books', bookId),
        bookshelfGetAll('chunks'),
    ]);
    if (!book) return;
    $('.ai-wbr-bookshelf-reader-overlay').remove();
    const reader = createBookshelfNovelReader(book, (chunks || []).filter(chunk => chunk.bookId === bookId));
    $('body').append(reader);
}

async function renderBookshelfPanel() {
    if (!$('#ai_wbr_bookshelf_panel').length) {
        ensureBookshelfStandaloneSection();
    }
    const panel = $('#ai_wbr_bookshelf_panel:visible').last().length
        ? $('#ai_wbr_bookshelf_panel:visible').last()
        : $('#ai_wbr_bookshelf_panel').last();
    if (!panel.length) return;
    ensureBookshelfStandaloneControls(panel.closest('#ai_wbr_bookshelf_section, .ai-wbr-bookshelf-fold'));

    const scope = getBookshelfScope();
    panel.find('#ai_wbr_bookshelf_enabled').prop('checked', !!settings.bookshelfEnabled);
    panel.find('#ai_wbr_bookshelf_auto_inject').prop('checked', !!settings.bookshelfAutoInject);
    panel.find('#ai_wbr_bookshelf_auto_memory_book').prop('checked', !!settings.bookshelfAutoMemoryBook);
    panel.find('#ai_wbr_bookshelf_memory_vector').prop('checked', !!settings.bookshelfMemoryVectorRecall);
    panel.find('#ai_wbr_bookshelf_only_bound').prop('checked', !!settings.bookshelfOnlyBound);
    panel.find('#ai_wbr_bookshelf_allow_global').prop('checked', !!settings.bookshelfAllowGlobal);
    panel.find('#ai_wbr_bookshelf_memory_vector_max').val(settings.bookshelfMemoryVectorMaxItems);
    panel.find('#ai_wbr_bookshelf_max_chunks').val(settings.bookshelfMaxChunks);
    panel.find('#ai_wbr_bookshelf_max_chars').val(settings.bookshelfMaxChunkChars);
    panel.find('#ai_wbr_bookshelf_min_score').val(settings.bookshelfMinScore);
    panel.find('#ai_wbr_bookshelf_api_url').val(settings.bookshelfApiUrl || '');
    panel.find('#ai_wbr_bookshelf_api_key').val(settings.bookshelfApiKey || '');
    renderBookshelfApiModelOptions();
    panel.find('#ai_wbr_bookshelf_api_model').val(settings.bookshelfApiModel || '');
    panel.find('#ai_wbr_bookshelf_local_model').val(settings.bookshelfLocalModelId || defaultSettings.bookshelfLocalModelId);
    panel.find('#ai_wbr_bookshelf_embedding_mode').val(getBookshelfEmbeddingMode());
    panel.find('#ai_wbr_bookshelf_test_query').val(settings.bookshelfLastTestQuery || '');
    setBookshelfStatus('Ready');

    panel.find('#ai_wbr_bookshelf_scope').empty().append(
        $('<div class="ai-wbr-bookshelf-scope-card"></div>').append($('<b></b>').text('当前角色卡'), $('<span></span>').text(scope.characterName || '当前角色')),
        $('<div class="ai-wbr-bookshelf-scope-card"></div>').append($('<b></b>').text('当前聊天'), $('<span></span>').text(scope.chatName || '当前聊天')),
        $('<div class="ai-wbr-bookshelf-scope-card"></div>').append($('<b></b>').text('自动注入'), $('<span></span>').text(settings.bookshelfEnabled && settings.bookshelfAutoInject ? '已开启' : '关闭')),
        $('<div class="ai-wbr-bookshelf-scope-card"></div>').append($('<b></b>').text('记忆书'), $('<span></span>').text(settings.bookshelfAutoMemoryBook ? '自动维护当前聊天' : '手动刷新')),
        $('<div class="ai-wbr-bookshelf-scope-card"></div>').append($('<b></b>').text('图谱向量'), $('<span></span>').text(settings.bookshelfMemoryVectorRecall ? `开启 · 最多 ${settings.bookshelfMemoryVectorMaxItems || defaultSettings.bookshelfMemoryVectorMaxItems} 条` : '关闭')),
        $('<div class="ai-wbr-bookshelf-scope-card"></div>').append($('<b></b>').text('向量模型'), $('<span></span>').text(getBookshelfEmbeddingProviderMeta().label)),
    );

    const booksBox = panel.find('#ai_wbr_bookshelf_books').empty().append('<div class="ai-wbr-token-empty">正在读取书架...</div>');
    const detailBox = panel.find('#ai_wbr_bookshelf_detail').empty();
    const resultsBox = panel.find('#ai_wbr_bookshelf_results');

    try {
        const [books, chunks] = await Promise.all([bookshelfGetAll('books'), bookshelfGetAll('chunks')]);
        const allBooks = (books || [])
            .filter(book => !(book?.autoGenerated && book?.autoSource === 'memory-graph' && book?.autoChatKey !== scope.chatKey))
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        const chunksByBook = new Map();
        for (const chunk of chunks || []) {
            if (!chunksByBook.has(chunk.bookId)) chunksByBook.set(chunk.bookId, []);
            chunksByBook.get(chunk.bookId).push(chunk);
        }

        if (selectedBookshelfBookId && !allBooks.some(book => book.id === selectedBookshelfBookId)) {
            selectedBookshelfBookId = '';
        }

        booksBox.empty();
        if (!allBooks.length) {
            booksBox.append('<div class="ai-wbr-token-empty">还没有导入 TXT。点击“导入 TXT”建立第一本补充资料。</div>');
        } else {
            for (const book of allBooks) {
                booksBox.append(createBookshelfBookCard(book, book.id === selectedBookshelfBookId));
            }
        }

        const selectedBook = allBooks.find(book => book.id === selectedBookshelfBookId) || null;
        if (!selectedBook) {
            detailBox.removeClass('open');
            detailBox.append('<div class="ai-wbr-token-empty">导入 TXT 后，点书籍封面查看向量化和删除操作。</div>');
        } else {
            detailBox.addClass('open');
            const selectedChunks = (chunksByBook.get(selectedBook.id) || []).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
            const isAutoMemoryBook = selectedBook.autoGenerated && selectedBook.autoSource === 'memory-graph';
            const { chapters: chapterList } = buildBookshelfNovelParts(selectedBook, selectedChunks);
            const isCharBound = isBookshelfBookBound(selectedBook, 'character', scope.characterKey);
            const isGlobalBound = isBookshelfBookBound(selectedBook, 'global', 'global');
            const actionBox = $('<div class="ai-wbr-bookshelf-actions"></div>')
                .append($('<button class="menu_button ai-wbr-bookshelf-rebuild" type="button"></button>').attr('data-bookshelf-book-id', selectedBook.id).text(Number(selectedBook.vectorizedCount || 0) ? '\u91cd\u65b0\u5411\u91cf\u5316' : '\u5f00\u59cb\u5411\u91cf\u5316'))
                .append($('<button class="menu_button ai-wbr-bookshelf-toggle" type="button"></button>').attr('data-bookshelf-book-id', selectedBook.id).text(selectedBook.enabled === false ? '\u542f\u7528\u53ec\u56de' : '\u505c\u7528\u53ec\u56de'));
            if (isAutoMemoryBook) {
                actionBox.append($('<button class="menu_button ai-wbr-bookshelf-open-reader" type="button"></button>').attr('data-bookshelf-book-id', selectedBook.id).text('打开小说阅读'));
            }
            if (!isAutoMemoryBook) {
                actionBox
                    .append($('<button class="menu_button ai-wbr-bookshelf-bind-character" type="button"></button>').attr('data-bookshelf-book-id', selectedBook.id).text(isCharBound ? '\u53d6\u6d88\u89d2\u8272\u5361\u7ed1\u5b9a' : '\u7ed1\u5b9a\u5f53\u524d\u89d2\u8272\u5361'))
                    .append($('<button class="menu_button ai-wbr-bookshelf-bind-global" type="button"></button>').attr('data-bookshelf-book-id', selectedBook.id).text(isGlobalBound ? '\u53d6\u6d88\u5168\u5c40' : '\u8bbe\u4e3a\u5168\u5c40'))
                    .append($('<button class="menu_button ai-wbr-bookshelf-clear-bindings" type="button"></button>').attr('data-bookshelf-book-id', selectedBook.id).text('\u6e05\u7a7a\u7ed1\u5b9a'));
            }
            actionBox
                .append($('<button class="menu_button ai-wbr-bookshelf-clear-vector" type="button"></button>').attr('data-bookshelf-book-id', selectedBook.id).text('\u91cd\u7f6e\u5411\u91cf'))
                .append($('<button class="menu_button ai-wbr-bookshelf-delete" type="button"></button>').attr('data-bookshelf-book-id', selectedBook.id).text('\u5220\u9664'));
            const novelHero = isAutoMemoryBook
                ? $('<div class="ai-wbr-bookshelf-novel-hero"></div>')
                    .append(
                        $('<div class="ai-wbr-bookshelf-novel-cover"></div>')
                            .append($('<span></span>').text('AIWBR'))
                            .append($('<b></b>').text(selectedBook.title || '记忆书'))
                            .append($('<small></small>').text(`${chapterList.length} 章 · ${selectedChunks.length} 小节`)),
                        $('<div class="ai-wbr-bookshelf-novel-info"></div>')
                            .append($('<strong></strong>').text(selectedBook.title || '记忆书'))
                            .append($('<p></p>').text(selectedBook.sourceSummary || '从当前聊天图谱自动整理，像小说一样按目录阅读，也可作为向量片段召回。'))
                            .append($('<div class="ai-wbr-bookshelf-novel-stats"></div>')
                                .append($('<span></span>').text(`章节 ${chapterList.length}`))
                                .append($('<span></span>').text(`小节 ${selectedChunks.length}`))
                                .append($('<span></span>').text(`向量 ${selectedBook.vectorizedCount || 0}/${selectedBook.chunkCount || 0}`))),
                    )
                : null;
            detailBox.append(
                $('<div class="ai-wbr-bookshelf-selected-detail"></div>')
                    .attr('data-bookshelf-book-id', selectedBook.id)
                    .append(
                $('<div class="ai-wbr-bookshelf-detail-head"></div>')
                    .append($('<b></b>').text(`《${selectedBook.title || selectedBook.fileName || '未命名'}》`))
                    .append($('<span></span>').text(`${getBookshelfTypeLabel(selectedBook.type)} · ${getBookshelfStatusLabel(selectedBook)} · ${selectedBook.vectorizedCount || 0}/${selectedBook.chunkCount || 0}`)),
                $('<div class="ai-wbr-bookshelf-tags"></div>').append(
                    getBookshelfBindingLabels(selectedBook).map(label => $('<span></span>').text(label)),
                    isAutoMemoryBook ? $('<span></span>').text('单聊天记录绑定') : null,
                ),
                novelHero,
                selectedBook.sourceSummary ? $('<div class="ai-wbr-bookshelf-source-summary"></div>').text(selectedBook.sourceSummary) : null,
                actionBox,
                isAutoMemoryBook
                    ? $('<div class="ai-wbr-token-empty"></div>').text('点击“打开小说阅读”进入独立阅读界面，目录和正文会在新界面中显示。')
                    : $('<div class="ai-wbr-bookshelf-chunk-list"></div>').append(
                        selectedChunks.slice(0, 24).map(chunk => (
                            $('<div class="ai-wbr-bookshelf-chunk"></div>')
                                .toggleClass('disabled', chunk.enabled === false)
                                .attr('data-bookshelf-chunk-id', chunk.id)
                                .append($('<div class="ai-wbr-bookshelf-chunk-head"></div>')
                                    .append($('<b></b>').text(`${String(chunk.order || '').padStart(2, '0')} · ${chunk.title || '片段'}`))
                                    .append($('<span></span>').text(chunk.enabled === false ? '禁用' : chunk.vectorStatus === 'ready' ? '已向量化' : chunk.vectorStatus === 'failed' ? '失败' : '待向量化')))
                                .append($('<p></p>').text(truncateText(chunk.text || '', 260)))
                        )),
                    ),
                    ),
            );
            if (!isAutoMemoryBook && selectedChunks.length > 24) {
                detailBox.append($('<div class="ai-wbr-token-empty"></div>').text(`已显示前 24 个片段，共 ${selectedChunks.length} 个。`));
            }
        }

        renderBookshelfResults(resultsBox, bookshelfLastTestResults);
        syncBookshelfProviderVisibility();
        setBookshelfStatus(bookshelfLastStatus || `书架共 ${allBooks.length} 本；只有已向量化片段会参与召回。`);
    } catch (error) {
        booksBox.empty().append($('<div class="ai-wbr-console-alert error"></div>').text(error?.message || String(error)));
        setBookshelfStatus(`书架读取失败：${error?.message || error}`);
    }
}

function getMemoryGraphSvgPoint(svg, clientX, clientY) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
}

function updateMemoryGraphViewBox(svg) {
    if (!svg || !memoryGraphView) {
        return;
    }
    svg.setAttribute('viewBox', `${memoryGraphView.x} ${memoryGraphView.y} ${memoryGraphView.width} ${memoryGraphView.height}`);
}

function getMemoryGraphViewportMetrics(containerEl) {
    const rect = containerEl?.getBoundingClientRect?.();
    const parentRect = containerEl?.parentElement?.getBoundingClientRect?.();
    const fallbackWidth = Math.max(320, Number(window.innerWidth || 960) - 420);
    const fallbackHeight = Math.max(320, Number(window.innerHeight || 720) - 150);
    const pixelWidth = Math.max(320, Number(rect?.width || parentRect?.width || fallbackWidth));
    const pixelHeight = Math.max(260, Number(rect?.height || parentRect?.height || fallbackHeight));
    const aspect = pixelWidth / pixelHeight;
    const baseWidth = MEMORY_GRAPH_CANVAS_WIDTH;
    const baseHeight = Math.max(MEMORY_GRAPH_CANVAS_HEIGHT, Math.min(980, MEMORY_GRAPH_CANVAS_WIDTH / aspect));
    return {
        aspect,
        baseWidth,
        baseHeight,
        layoutWidth: baseWidth,
        layoutHeight: baseHeight,
    };
}

function getMemoryGraphNodesBounds(nodes) {
    const valid = (Array.isArray(nodes) ? nodes : [])
        .map(node => ({
            x: Number(node?.x),
            y: Number(node?.y),
        }))
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!valid.length) {
        return null;
    }

    const minX = Math.min(...valid.map(point => point.x));
    const minY = Math.min(...valid.map(point => point.y));
    const maxX = Math.max(...valid.map(point => point.x + MEMORY_GRAPH_NODE_WIDTH));
    const maxY = Math.max(...valid.map(point => point.y + MEMORY_GRAPH_NODE_HEIGHT));
    return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
    };
}

function fitMemoryGraphToNodes(nodes, containerEl) {
    const viewport = getMemoryGraphViewportMetrics(containerEl);
    const bounds = getMemoryGraphNodesBounds(nodes);
    if (!bounds) {
        memoryGraphView = { x: 0, y: 0, width: viewport.baseWidth, height: viewport.baseHeight };
        return;
    }

    const padding = MEMORY_GRAPH_LAYOUT_PADDING;
    let viewWidth = Math.max(320, bounds.width + padding * 2);
    let viewHeight = Math.max(220, bounds.height + padding * 2);
    const currentAspect = viewWidth / viewHeight;
    if (currentAspect < viewport.aspect) {
        viewWidth = viewHeight * viewport.aspect;
    } else {
        viewHeight = viewWidth / viewport.aspect;
    }

    viewWidth = Math.min(1600, Math.max(260, viewWidth));
    viewHeight = Math.min(1400, Math.max(180, viewHeight));
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    memoryGraphView = {
        x: centerX - viewWidth / 2,
        y: centerY - viewHeight / 2,
        width: viewWidth,
        height: viewHeight,
    };
}

function fitMemoryGraphToContainer(graph = getMemoryGraph()) {
    const container = $('#ai_wbr_memory_graph');
    if (!container.length) {
        return;
    }
    const nodes = buildMemoryGraphDisplayModel(graph).nodes;
    fitMemoryGraphToNodes(nodes, container[0]);
}

function normalizeMemoryGraphLayout(nodes, links = [], canvasWidth = MEMORY_GRAPH_CANVAS_WIDTH, canvasHeight = MEMORY_GRAPH_CANVAS_HEIGHT) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
        return false;
    }

    const nodeIds = new Set(nodes.map(node => node.id));
    const degree = new Map(nodes.map(node => [node.id, 0]));
    for (const link of Array.isArray(links) ? links : []) {
        if (!nodeIds.has(link?.source) || !nodeIds.has(link?.target)) {
            continue;
        }
        const weight = clampNumber(link.weight, 0.7, 0, 1);
        degree.set(link.source, (degree.get(link.source) || 0) + weight);
        degree.set(link.target, (degree.get(link.target) || 0) + weight);
    }

    const isValidPosition = node => {
        const x = Number(node?.x);
        const y = Number(node?.y);
        return Number.isFinite(x)
            && Number.isFinite(y)
            && x > -canvasWidth * 0.35
            && y > -canvasHeight * 0.35
            && x < canvasWidth * 1.35
            && y < canvasHeight * 1.35;
    };

    const bounds = getMemoryGraphNodesBounds(nodes);
    const invalidLayout = nodes.some(node => !isValidPosition(node));
    const overextendedLayout = bounds
        ? bounds.width > canvasWidth * 1.35
            || bounds.height > canvasHeight * 1.35
            || bounds.x < -canvasWidth * 0.25
            || bounds.y < -canvasHeight * 0.25
        : true;
    const verticalStack = bounds && nodes.length > 3
        && bounds.width < MEMORY_GRAPH_NODE_WIDTH * 1.85
        && bounds.height > MEMORY_GRAPH_NODE_HEIGHT * 3.2;
    const positions = new Map(nodes
        .filter(node => Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y)))
        .map(node => [node.id, { x: Number(node.x), y: Number(node.y) }]));
    const visibleLinks = (Array.isArray(links) ? links : [])
        .filter(link => positions.has(link?.source) && positions.has(link?.target));
    const longVerticalLinks = visibleLinks.filter((link) => {
        const source = positions.get(link.source);
        const target = positions.get(link.target);
        const dx = Math.abs((target.x + MEMORY_GRAPH_NODE_WIDTH / 2) - (source.x + MEMORY_GRAPH_NODE_WIDTH / 2));
        const dy = Math.abs((target.y + MEMORY_GRAPH_NODE_HEIGHT / 2) - (source.y + MEMORY_GRAPH_NODE_HEIGHT / 2));
        return dy > MEMORY_GRAPH_NODE_HEIGHT * 2.4 && dx < MEMORY_GRAPH_NODE_WIDTH * 0.72;
    });
    const awkwardConnections = visibleLinks.length >= 2
        && longVerticalLinks.length / visibleLinks.length >= 0.45;

    if (!invalidLayout && !overextendedLayout && !verticalStack && !awkwardConnections) {
        return false;
    }

    const ranked = nodes.map((node, index) => ({
        node,
        index,
        score: (degree.get(node.id) || 0) + clampNumber(node.importance, 0.5, 0, 1) + ((nodes.length - index) / 1000),
    })).sort((a, b) => b.score - a.score);
    const centerX = canvasWidth / 2;
    const centerY = canvasHeight / 2;
    const maxPerRing = 8;

    ranked.forEach((item, index) => {
        let x;
        let y;
        if (index === 0) {
            x = centerX - MEMORY_GRAPH_NODE_WIDTH / 2;
            y = centerY - MEMORY_GRAPH_NODE_HEIGHT / 2;
        } else {
            const ringIndex = Math.floor((index - 1) / maxPerRing);
            const ringStart = 1 + ringIndex * maxPerRing;
            const ringCount = Math.min(maxPerRing, ranked.length - ringStart);
            const indexInRing = index - ringStart;
            const angle = (-Math.PI / 2) + (Math.PI * 2 * indexInRing / Math.max(1, ringCount)) + (ringIndex * 0.28);
            const radiusX = Math.min(canvasWidth * 0.38, 190 + ringIndex * 130);
            const radiusY = Math.min(canvasHeight * 0.34, 150 + ringIndex * 110);
            x = centerX + Math.cos(angle) * radiusX - MEMORY_GRAPH_NODE_WIDTH / 2;
            y = centerY + Math.sin(angle) * radiusY - MEMORY_GRAPH_NODE_HEIGHT / 2;
        }

        const clamped = clampMemoryNodePosition(x, y, canvasWidth, canvasHeight, MEMORY_GRAPH_SAFE_PADDING);
        item.node.x = clamped.x;
        item.node.y = clamped.y;
    });
    return true;
}

function syncMemoryGraphViewToContainerAspect(containerEl) {
    if (!memoryGraphView || !Number.isFinite(memoryGraphView.width)) {
        return;
    }
    const { aspect } = getMemoryGraphViewportMetrics(containerEl);
    const nextHeight = Math.max(120, memoryGraphView.width / Math.max(0.2, aspect));
    if (!Number.isFinite(nextHeight) || Math.abs(nextHeight - memoryGraphView.height) < 0.5) {
        return;
    }
    const centerY = memoryGraphView.y + (memoryGraphView.height / 2);
    memoryGraphView.height = nextHeight;
    memoryGraphView.y = centerY - (nextHeight / 2);
}

function parseMemoryNodeTransform(transform) {
    const text = String(transform || '');
    const match = text.match(/translate\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/i);
    if (!match) {
        return null;
    }
    return {
        x: Number(match[1]),
        y: Number(match[2]),
    };
}

function getOptionLabel(options, value, fallback = '') {
    const normalizedValue = String(value || '');
    return options.find(option => option.value === normalizedValue)?.label || fallback || normalizedValue;
}

function clampMemoryNodePosition(x, y, canvasWidth = MEMORY_GRAPH_CANVAS_WIDTH, canvasHeight = MEMORY_GRAPH_CANVAS_HEIGHT, topPadding = MEMORY_GRAPH_TOP_SAFE_PADDING) {
    return {
        x: Math.min(
            canvasWidth - MEMORY_GRAPH_NODE_WIDTH - MEMORY_GRAPH_SAFE_PADDING,
            Math.max(MEMORY_GRAPH_SAFE_PADDING, Number(x || 0)),
        ),
        y: Math.min(
            canvasHeight - MEMORY_GRAPH_NODE_HEIGHT - MEMORY_GRAPH_SAFE_PADDING,
            Math.max(topPadding, Number(y || 0)),
        ),
    };
}

function clampMemoryNodePositionToView(x, y, view = memoryGraphView, topPadding = 0) {
    const safeTop = Math.max(0, Number(topPadding || 0));
    const overflowAllowanceX = MEMORY_GRAPH_NODE_WIDTH * 0.45;
    const overflowAllowanceY = MEMORY_GRAPH_NODE_HEIGHT * 0.45;
    const minX = Number(view?.x || 0) - overflowAllowanceX;
    const minY = Number(view?.y || 0) + safeTop - overflowAllowanceY;
    const maxX = Number(view?.x || 0) + Number(view?.width || MEMORY_GRAPH_CANVAS_WIDTH) - MEMORY_GRAPH_NODE_WIDTH + overflowAllowanceX;
    const maxY = Number(view?.y || 0) + Number(view?.height || MEMORY_GRAPH_CANVAS_HEIGHT) - MEMORY_GRAPH_NODE_HEIGHT + overflowAllowanceY;
    return {
        x: Math.min(maxX, Math.max(minX, Number(x || 0))),
        y: Math.min(maxY, Math.max(minY, Number(y || 0))),
    };
}

function getMemoryNodeRect(position) {
    return {
        x: Number(position?.x || 0),
        y: Number(position?.y || 0),
        width: MEMORY_GRAPH_NODE_WIDTH,
        height: MEMORY_GRAPH_NODE_HEIGHT,
    };
}

function buildMemoryEdgePath(sourcePosition, targetPosition, laneOffset = 0) {
    const sourceRect = getMemoryNodeRect(sourcePosition);
    const targetRect = getMemoryNodeRect(targetPosition);
    const sourceCenter = {
        x: sourceRect.x + (sourceRect.width / 2),
        y: sourceRect.y + (sourceRect.height / 2),
    };
    const targetCenter = {
        x: targetRect.x + (targetRect.width / 2),
        y: targetRect.y + (targetRect.height / 2),
    };
    const dx = targetCenter.x - sourceCenter.x;
    const dy = targetCenter.y - sourceCenter.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);

    let startX;
    let startY;
    let endX;
    let endY;
    let control1X;
    let control1Y;
    let control2X;
    let control2Y;

    if (horizontal) {
        const sourceToRight = dx >= 0;
        startX = sourceToRight ? sourceRect.x + sourceRect.width : sourceRect.x;
        startY = sourceRect.y + (sourceRect.height / 2);
        endX = sourceToRight ? targetRect.x : targetRect.x + targetRect.width;
        endY = targetRect.y + (targetRect.height / 2);
        const curve = Math.max(42, Math.abs(endX - startX) * 0.35);
        control1X = startX + (sourceToRight ? curve : -curve);
        control1Y = startY + laneOffset;
        control2X = endX + (sourceToRight ? -curve : curve);
        control2Y = endY + laneOffset;
        startY += laneOffset * 0.35;
        endY += laneOffset * 0.35;
    } else {
        const sourceToBottom = dy >= 0;
        startX = sourceRect.x + (sourceRect.width / 2);
        startY = sourceToBottom ? sourceRect.y + sourceRect.height : sourceRect.y;
        endX = targetRect.x + (targetRect.width / 2);
        endY = sourceToBottom ? targetRect.y : targetRect.y + targetRect.height;
        const curve = Math.max(34, Math.abs(endY - startY) * 0.35);
        control1X = startX + laneOffset;
        control1Y = startY + (sourceToBottom ? curve : -curve);
        control2X = endX + laneOffset;
        control2Y = endY + (sourceToBottom ? -curve : curve);
        startX += laneOffset * 0.35;
        endX += laneOffset * 0.35;
    }

    return `M ${startX} ${startY} C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${endX} ${endY}`;
}

function buildSelectOptionsHtml(options, currentValue) {
    const normalizedValue = String(currentValue || '');
    const known = options.some(option => option.value === normalizedValue);
    const optionHtml = options.map(option => `<option value="${escapeHtml(option.value)}" ${option.value === normalizedValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
    if (!known && normalizedValue) {
        return `${optionHtml}<option value="${escapeHtml(normalizedValue)}" selected>自定义（${escapeHtml(normalizedValue)}）</option>`;
    }
    return optionHtml;
}

function buildNodeTypeSelect(fieldName, currentValue, extraAttributes = '') {
    return `<select class="text_pole" ${extraAttributes} data-${fieldName}="type">${buildSelectOptionsHtml(MEMORY_NODE_TYPE_OPTIONS, currentValue || 'event')}</select>`;
}

function buildLinkTypeSelect(fieldName, currentValue, extraAttributes = '') {
    return `<select class="text_pole" ${extraAttributes} data-${fieldName}="type">${buildSelectOptionsHtml(MEMORY_LINK_TYPE_OPTIONS, currentValue || 'RELATED')}</select>`;
}

function createNodeTypeSelect(fieldAttrName, currentValue, extraData = {}) {
    const select = $('<select class="text_pole"></select>').attr(fieldAttrName, 'type');
    for (const option of MEMORY_NODE_TYPE_OPTIONS) {
        select.append($('<option></option>').attr('value', option.value).text(option.label));
    }
    const normalizedValue = String(currentValue || 'event');
    if (!MEMORY_NODE_TYPE_OPTIONS.some(option => option.value === normalizedValue) && normalizedValue) {
        select.append($('<option></option>').attr('value', normalizedValue).text(`自定义（${normalizedValue}）`));
    }
    select.val(normalizedValue);
    for (const [key, value] of Object.entries(extraData)) {
        select.attr(key, value);
    }
    return select;
}

function createLinkTypeSelect(fieldAttrName, currentValue, extraData = {}) {
    const select = $('<select class="text_pole"></select>').attr(fieldAttrName, 'type');
    for (const option of MEMORY_LINK_TYPE_OPTIONS) {
        select.append($('<option></option>').attr('value', option.value).text(option.label));
    }
    const normalizedValue = String(currentValue || 'RELATED');
    if (!MEMORY_LINK_TYPE_OPTIONS.some(option => option.value === normalizedValue) && normalizedValue) {
        select.append($('<option></option>').attr('value', normalizedValue).text(`自定义（${normalizedValue}）`));
    }
    select.val(normalizedValue);
    for (const [key, value] of Object.entries(extraData)) {
        select.attr(key, value);
    }
    return select;
}

function showMemoryNodePopover(nodeId, clientX, clientY) {
    memoryGraphSelectedNodeId = String(nodeId || '');
    renderMemoryPanel();

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
            <label>类型${buildNodeTypeSelect('popover-node-field', node.type || 'event')}</label>
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
    const previewPanel = $('#ai_wbr_memory_preview_panel');
    container.off('.memoryGraphSvg');
    previewPanel.off('.memoryGraphPreview');
    $(document).off('.memoryGraphSvg');

    const renderCurrentGraph = (options = {}) => {
        if (memoryGraphRenderFrame) {
            cancelAnimationFrame(memoryGraphRenderFrame);
        }
        memoryGraphRenderFrame = requestAnimationFrame(() => {
            memoryGraphRenderFrame = null;
            const graph = getMemoryGraph();
            if (options.fit) {
                fitMemoryGraphToNodes(buildMemoryGraphDisplayModel(graph).nodes, container[0]);
            }
            renderMemoryGraphSvg(graph);
        });
    };

    previewPanel.on('input.memoryGraphPreview', '.ai-wbr-memory-preview-search', function (event) {
        event.stopPropagation();
        const value = String($(this).val() || '');
        clearTimeout(memoryGraphSearchTimer);
        memoryGraphSearchTimer = setTimeout(() => {
            memoryGraphSearchText = value;
            renderCurrentGraph({ fit: true });
        }, 180);
    });

    previewPanel.on('click.memoryGraphPreview', '.ai-wbr-memory-preview-card', function (event) {
        event.preventDefault();
        const nodeId = String($(this).data('memoryNodeId') || '');
        if (!nodeId) {
            return;
        }
        memoryGraphSelectedNodeId = nodeId;
        memoryGraphSelectedLinkId = '';
        memoryGraphDetailMode = 'node';
        memoryGraphDisplayMode = 'focus';
        previewPanel.closest('.ai-wbr-graph-shell').removeClass('preview-open');
        renderMemoryPanel('graph');
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-timeline-card', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const nodeId = String($(this).data('memoryNodeId') || '');
        if (!nodeId) {
            return;
        }
        memoryGraphSelectedNodeId = nodeId;
        memoryGraphSelectedLinkId = '';
        memoryGraphDetailMode = 'node';
        renderMemoryPanel('graph');
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-mode', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const mode = String($(this).data('memoryGraphMode') || 'overview');
        if (mode === 'focus' && !memoryGraphSelectedNodeId) {
            return;
        }
        memoryGraphDisplayMode = mode;
        renderCurrentGraph({ fit: true });
    });

    container.on('input.memoryGraphSvg', '.ai-wbr-memory-graph-search', function (event) {
        event.stopPropagation();
        const value = String($(this).val() || '');
        clearTimeout(memoryGraphSearchTimer);
        memoryGraphSearchTimer = setTimeout(() => {
            memoryGraphSearchText = value;
            renderCurrentGraph({ fit: true });
        }, 180);
    });

    container.on('input.memoryGraphSvg', '.ai-wbr-memory-link-weight', function (event) {
        event.stopPropagation();
        memoryGraphMinLinkWeight = clampNumber($(this).val(), 0.35, 0, 1);
        clearTimeout(memoryGraphSearchTimer);
        memoryGraphSearchTimer = setTimeout(() => renderCurrentGraph(), 120);
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-type-filter', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const type = String($(this).data('memoryNodeType') || '');
        if (!type) {
            return;
        }
        const graph = getMemoryGraph();
        const allTypes = [...new Set((Array.isArray(graph?.nodes) ? graph.nodes : []).map(node => String(node?.type || 'event')))];
        if (!(memoryGraphVisibleTypes instanceof Set)) {
            memoryGraphVisibleTypes = new Set();
        }
        if (memoryGraphVisibleTypes.size === 0) {
            memoryGraphVisibleTypes = new Set(allTypes.filter(item => item !== type));
        } else if (memoryGraphVisibleTypes.has(type)) {
            memoryGraphVisibleTypes.delete(type);
        } else {
            memoryGraphVisibleTypes.add(type);
        }
        if (memoryGraphVisibleTypes.size >= allTypes.length) {
            memoryGraphVisibleTypes.clear();
        }
        renderCurrentGraph({ fit: true });
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-clear-filters', function (event) {
        event.preventDefault();
        event.stopPropagation();
        memoryGraphDisplayMode = 'overview';
        memoryGraphMinLinkWeight = 0.35;
        memoryGraphSearchText = '';
        clearTimeout(memoryGraphSearchTimer);
        memoryGraphVisibleTypes.clear();
        renderCurrentGraph({ fit: true });
    });

    const svg = container.find('svg')[0];
    if (!svg) {
        return;
    }

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
        fitMemoryGraphToNodes(buildMemoryGraphDisplayModel(getMemoryGraph()).nodes, container[0]);
        updateMemoryGraphViewBox(svg);
    });

    container.on('pointerdown.memoryGraphSvg', '.ai-wbr-memory-node', function (event) {
        const nodeId = String($(this).data('memoryNodeId'));
        const original = event.originalEvent || event;
        const start = getMemoryGraphSvgPoint(svg, original.clientX, original.clientY);
        const graph = getMemoryGraph();
        const node = graph.nodes.find(item => item.id === nodeId);
        const transform = parseMemoryNodeTransform($(this).attr('transform'));
        if (!node) {
            return;
        }

        const nodePositions = new Map();
        container.find('.ai-wbr-memory-node').each(function () {
            const id = String($(this).data('memoryNodeId'));
            const t = parseMemoryNodeTransform($(this).attr('transform'));
            if (t) {
                nodePositions.set(id, t);
            }
        });

        const visibleIds = new Set(Array.from(nodePositions.keys()));
        const edges = graph.links.filter(link => visibleIds.has(link.source) && visibleIds.has(link.target));
        const pairBuckets = new Map();
        edges.forEach((link) => {
            const pairKey = [String(link.source || ''), String(link.target || '')].sort().join('||');
            if (!pairBuckets.has(pairKey)) {
                pairBuckets.set(pairKey, []);
            }
            pairBuckets.get(pairKey).push(link);
        });

        const linkOffsets = new Map();
        edges.forEach((link) => {
            const pairKey = [String(link.source || ''), String(link.target || '')].sort().join('||');
            const siblings = (pairBuckets.get(pairKey) || []).slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
            const siblingIndex = siblings.findIndex(item => String(item.id || '') === String(link.id || ''));
            const offsetIndex = siblingIndex - ((siblings.length - 1) / 2);
            linkOffsets.set(link.id, siblings.length > 1 ? offsetIndex * 18 : 0);
        });

        const longPressTimer = setTimeout(() => {
            if (!memoryGraphDrag || memoryGraphDrag.nodeId !== nodeId || memoryGraphDrag.moved) {
                return;
            }
            memoryGraphDrag.longPressed = true;
            memoryGraphSuppressNextNodeClick = true;
            memoryGraphSelectedNodeId = nodeId;
            memoryGraphSelectedLinkId = '';
            memoryGraphDetailMode = 'node';
            renderMemoryDetailDrawer(getMemoryGraph());
            $('#ai_wbr_memory_node_popover').hide();
        }, MEMORY_GRAPH_LONG_PRESS_MS);

        memoryGraphDrag = {
            nodeId,
            startX: start.x,
            startY: start.y,
            nodeX: Number.isFinite(transform?.x) ? transform.x : Number(node.x || 0),
            nodeY: Number.isFinite(transform?.y) ? transform.y : Number(node.y || 0),
            moved: false,
            longPressed: false,
            longPressTimer,
            nodePositions,
            linkOffsets,
            links: edges.filter(link => link.source === nodeId || link.target === nodeId),
            pointerId: original.pointerId,
        };
        this.setPointerCapture?.(original.pointerId);
        event.preventDefault();
        event.stopPropagation();
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-node', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (memoryGraphSuppressNextNodeClick) {
            memoryGraphSuppressNextNodeClick = false;
            return;
        }
        const nodeId = String($(this).data('memoryNodeId') || '');
        if (!nodeId) {
            return;
        }
        memoryGraphSelectedNodeId = nodeId;
        memoryGraphSelectedLinkId = '';
        memoryGraphDetailMode = '';
        memoryGraphDisplayMode = 'focus';
        renderMemoryPanel('graph');
        $('#ai_wbr_memory_node_popover').hide();
    });

    $(document).off('click.memoryGraphShellToggles')
        .on('click.memoryGraphShellToggles', '#ai_wbr_memory_graph_preview_toggle', function (event) {
            event.preventDefault();
            $('#ai_wbr_memory_preview_panel').closest('.ai-wbr-graph-shell').toggleClass('preview-open');
            memoryGraphPreviewRenderKey = '';
            renderMemoryGraphSvg(getMemoryGraph());
        });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-edge, .ai-wbr-memory-edge-hit', function (event) {
        event.preventDefault();
        event.stopPropagation();
        memoryGraphSelectedLinkId = String($(this).data('memoryLinkId') || '');
        memoryGraphSelectedNodeId = '';
        memoryGraphDetailMode = 'link';
        renderMemoryPanel('graph');
    });

    container.on('pointerdown.memoryGraphSvg', '.ai-wbr-memory-edge, .ai-wbr-memory-edge-hit', function (event) {
        event.preventDefault();
        event.stopPropagation();
    });

    container.on('pointerdown.memoryGraphSvg', 'svg', function (event) {
        if ($(event.target).closest('.ai-wbr-memory-node').length) {
            return;
        }
        const original = event.originalEvent || event;

        memoryGraphPan = {
            startClientX: original.clientX,
            startClientY: original.clientY,
            viewX: memoryGraphView.x,
            viewY: memoryGraphView.y,
            moved: false,
            pointerId: original.pointerId,
        };
        svg.setPointerCapture?.(original.pointerId);
        $('#ai_wbr_memory_node_popover').hide();
        $(svg).addClass('ai-wbr-memory-panning');
        event.preventDefault();
    });

    $(document).on('pointermove.memoryGraphSvg', (event) => {
        const original = event.originalEvent || event;
        if (!memoryGraphDrag) {
            if (memoryGraphPan) {
                if (memoryGraphPan.pointerId !== undefined && original.pointerId !== undefined && memoryGraphPan.pointerId !== original.pointerId) {
                    return;
                }
                const rect = svg.getBoundingClientRect();
                const dx = (original.clientX - memoryGraphPan.startClientX) * (memoryGraphView.width / Math.max(1, rect.width));
                const dy = (original.clientY - memoryGraphPan.startClientY) * (memoryGraphView.height / Math.max(1, rect.height));
                if (Math.abs(dx) + Math.abs(dy) > MEMORY_GRAPH_TOUCH_TAP_THRESHOLD) {
                    memoryGraphPan.moved = true;
                }
                memoryGraphView.x = memoryGraphPan.viewX - dx;
                memoryGraphView.y = memoryGraphPan.viewY - dy;
                updateMemoryGraphViewBox(svg);
                event.preventDefault();
            }
            return;
        }
        if (memoryGraphDrag.pointerId !== undefined && original.pointerId !== undefined && memoryGraphDrag.pointerId !== original.pointerId) {
            return;
        }
        const point = getMemoryGraphSvgPoint(svg, original.clientX, original.clientY);
        const dx = point.x - memoryGraphDrag.startX;
        const dy = point.y - memoryGraphDrag.startY;
        if (Math.abs(dx) + Math.abs(dy) > MEMORY_GRAPH_TOUCH_TAP_THRESHOLD) {
            memoryGraphDrag.moved = true;
            if (memoryGraphDrag.longPressTimer) {
                clearTimeout(memoryGraphDrag.longPressTimer);
                memoryGraphDrag.longPressTimer = null;
            }
        }
        
        const clamped = clampMemoryNodePositionToView(memoryGraphDrag.nodeX + dx, memoryGraphDrag.nodeY + dy);
        memoryGraphDrag.pendingPosition = clamped;
        if (!memoryGraphDragFrame) {
            memoryGraphDragFrame = requestAnimationFrame(() => {
                memoryGraphDragFrame = null;
                if (!memoryGraphDrag?.pendingPosition) {
                    return;
                }
                const next = memoryGraphDrag.pendingPosition;
                memoryGraphDrag.pendingPosition = null;
                memoryGraphDrag.nodePositions.set(memoryGraphDrag.nodeId, { x: next.x, y: next.y });

                const group = container.find(`.ai-wbr-memory-node[data-memory-node-id="${escapeCssSelector(memoryGraphDrag.nodeId)}"]`);
                group.attr('transform', `translate(${next.x},${next.y})`);

                memoryGraphDrag.links.forEach((link) => {
                    const line = container.find(`[data-memory-link-id="${escapeCssSelector(String(link.id || ''))}"]`);
                    const source = memoryGraphDrag.nodePositions.get(link.source);
                    const target = memoryGraphDrag.nodePositions.get(link.target);
                    const laneOffset = memoryGraphDrag.linkOffsets.get(link.id) || 0;
                    if (source && target) {
                        line.attr('d', buildMemoryEdgePath(source, target, laneOffset));
                    }
                });
            });
        }
        event.preventDefault();
    });

    $(document).on('pointerup.memoryGraphSvg pointercancel.memoryGraphSvg', (event) => {
        const original = event.originalEvent || event;
        if (memoryGraphPan) {
            if (memoryGraphPan.pointerId !== undefined && original.pointerId !== undefined && memoryGraphPan.pointerId !== original.pointerId) {
                return;
            }
            memoryGraphPan = null;
            $(svg).removeClass('ai-wbr-memory-panning');
            lastObservedChatScopedUiSignature = getChatScopedUiSignature();
            return;
        }

        if (!memoryGraphDrag) {
            return;
        }
        if (memoryGraphDrag.pointerId !== undefined && original.pointerId !== undefined && memoryGraphDrag.pointerId !== original.pointerId) {
            return;
        }
        const drag = memoryGraphDrag;
        memoryGraphDrag = null;
        if (drag.longPressTimer) {
            clearTimeout(drag.longPressTimer);
        }
        if (memoryGraphDragFrame) {
            cancelAnimationFrame(memoryGraphDragFrame);
            memoryGraphDragFrame = null;
        }
        const graph = getMemoryGraph();
        const node = graph.nodes.find(item => item.id === drag.nodeId);
        if (node) {
            const point = getMemoryGraphSvgPoint(svg, original.clientX, original.clientY);
            const dx = point.x - drag.startX;
            const dy = point.y - drag.startY;
            const clamped = clampMemoryNodePositionToView(drag.nodeX + dx, drag.nodeY + dy);
            node.x = clamped.x;
            node.y = clamped.y;
            node.updatedAt = new Date().toISOString();
        }
        graph.updatedAt = new Date().toISOString();
        saveMemoryGraph(graph, getContext(), true);
        lastObservedChatScopedUiSignature = getChatScopedUiSignature();

        if (!drag.moved && !drag.longPressed) {
            memoryGraphSelectedNodeId = drag.nodeId;
            memoryGraphSelectedLinkId = '';
            memoryGraphDetailMode = '';
            memoryGraphDisplayMode = 'focus';
            renderMemoryPanel('graph');
            $('#ai_wbr_memory_node_popover').hide();
        } else if (drag.longPressed) {
            renderMemoryDetailDrawer(getMemoryGraph());
        } else {
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
        }
    });

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_node_popover .ai-wbr-memory-popover-save', function () {
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

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_node_popover .ai-wbr-memory-set-link-source', function () {
        const nodeId = String($('#ai_wbr_memory_node_popover').data('memoryNodeId'));
        memoryGraphLinkSourceId = nodeId;
        renderMemoryGraphSvg(getMemoryGraph());
    });

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_node_popover .ai-wbr-memory-link-to-source', function () {
        const graph = getMemoryGraph();
        const targetId = String($('#ai_wbr_memory_node_popover').data('memoryNodeId'));
        if (!memoryGraphLinkSourceId || memoryGraphLinkSourceId === targetId) {
            return;
        }
        const existingIndex = graph.links.findIndex(item => item.source === memoryGraphLinkSourceId && item.target === targetId && item.type === 'RELATED');
        if (existingIndex >= 0) {
            graph.links.splice(existingIndex, 1);
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
            memoryGraphLinkSourceId = '';
            $('#ai_wbr_memory_node_popover').hide();
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

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_node_popover .ai-wbr-memory-popover-delete', function () {
        const graph = getMemoryGraph();
        const nodeId = String($('#ai_wbr_memory_node_popover').data('memoryNodeId'));
        graph.nodes = graph.nodes.filter(node => node.id !== nodeId);
        graph.links = graph.links.filter(link => link.source !== nodeId && link.target !== nodeId);
        saveMemoryGraph(graph);
        $('#ai_wbr_memory_node_popover').hide();
    });

    container.on('click.memoryGraphSvg', function (event) {
        if ($(event.target).closest('.ai-wbr-memory-node, .ai-wbr-memory-edge, .ai-wbr-memory-edge-hit, .ai-wbr-memory-graph-toolbar').length) {
            return;
        }
        memoryGraphSelectedNodeId = '';
        memoryGraphSelectedLinkId = '';
        memoryGraphDetailMode = '';
        renderMemoryDetailDrawer(getMemoryGraph());
        $('#ai_wbr_memory_node_popover').hide();
    });
}

function renderMemoryPanel(scope = 'all') {
    const hasMemoryPanel = $('#ai_wbr_memory_status, #ai_wbr_memory_review_queue, #ai_wbr_memory_state_editor').length > 0;
    const hasGraphPanel = $('#ai_wbr_memory_graph').length > 0;
    const hasGraphListPanel = $('#ai_wbr_memory_nodes, #ai_wbr_memory_links').length > 0;
    if (!hasMemoryPanel && !hasGraphPanel) {
        return;
    }

    const context = getContext();
    const graph = getMemoryGraph(context);
    memoryScopeDebugLog('renderMemoryPanel', {
        graph: getMemoryGraphSummary(graph),
        selectedNodeId: memoryGraphSelectedNodeId,
        linkSourceId: memoryGraphLinkSourceId,
    });
    if (hasMemoryPanel) {
        $('#ai_wbr_memory_status').text(getCurrentMemoryStatus() || (settings.memoryEnabled ? '待整理' : '未启用'));
        $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
        const showMemoryDebugDetails = !!settings.memoryDebug || !!getCurrentMemoryLastError(context);
        $('.ai-wbr-memory-debug-fold').prop('open', showMemoryDebugDetails);
        $('#ai_wbr_memory_debug_panel .ai-wbr-router-raw-block').toggle(showMemoryDebugDetails);
        $('#ai_wbr_memory_prompt').text(getCurrentMemoryLastPrompt(context) || '尚无后置记忆 Prompt');
        $('#ai_wbr_memory_raw').text(getCurrentMemoryLastRaw(context) || '尚无后置记忆返回');
        $('#ai_wbr_memory_error').text(getCurrentMemoryLastError(context) || '尚无错误');
        renderMemoryDashboard(graph);
        renderMemoryReviewQueue();
        renderBookshelfPanel();
        if ($('#ai_wbr_memory_history_preview_box').length) {
            buildHistoryImportPreview(getHistoryImportRangeFromUi(context), context);
        }
    }
    renderMemoryGraphSvg(graph);
    renderMemoryNodeEditor(graph);
    renderMemoryEdgeEditor(graph);
    renderMemoryDetailDrawer(graph);

    if (hasMemoryPanel) {
        const stateRows = getMemoryStateRows(graph);
        const stateTable = $('<table class="ai-wbr-memory-table"></table>');
        stateTable.append('<thead><tr><th>状态字段</th><th>当前值</th></tr></thead>');
        const stateBody = $('<tbody></tbody>');
        for (const row of stateRows) {
            stateBody.append(
                $('<tr></tr>')
                    .append($('<th scope="row"></th>')
                        .append($('<div></div>').text(row.label))
                        .append(row.description ? $('<div class="ai-wbr-memory-state-desc"></div>').text(row.description) : '')
                        .append(row.isCustom
                            ? $('<button class="menu_button ai-wbr-memory-delete-state-definition m-t-05" type="button">删除</button>')
                                .attr('data-memory-state-definition-key', row.key)
                            : ''))
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" />')
                            .attr('data-memory-state-field', row.key)
                            .val(row.value),
                    )),
            );
        }
        stateTable.append(stateBody);
        $('#ai_wbr_memory_state_editor').empty().append(
            $('<div class="ai-wbr-memory-subtitle"><b>新增自定义状态字段</b></div>'),
            $(`
                <div class="ai-wbr-memory-add-state">
                    <input id="ai_wbr_memory_new_state_label" class="text_pole" type="text" placeholder="字段名，例如：道具" />
                    <input id="ai_wbr_memory_new_state_instruction" class="text_pole" type="text" placeholder="字段说明，例如：user背包里的道具" />
                    <button id="ai_wbr_memory_add_state_definition" class="menu_button" type="button">添加字段</button>
                </div>
            `),
            $('<div class="ai-wbr-memory-subtitle"><b>状态表（固定更新）</b></div>'),
            $('<div class="ai-wbr-memory-table-wrap"></div>').append(stateTable),
        );
    }

    if (!hasMemoryPanel && !hasGraphListPanel) {
        return;
    }

    const eventNodes = getMemoryEventNodes(graph);
    const nonEventNodes = getMemoryNonEventNodes(graph);
    const nodesContainer = $('#ai_wbr_memory_nodes').empty();
    nodesContainer.append($('<div class="ai-wbr-memory-subtitle"><b>事件表（剧情推进会新增）</b></div>'));
    if (!eventNodes.length) {
        nodesContainer.append('<div class="ai-wbr-token-empty">暂无事件记录</div>');
    } else {
        const eventTable = $('<table class="ai-wbr-memory-table ai-wbr-memory-event-table"></table>');
        eventTable.append('<thead><tr><th>标题</th><th>地点 / 时间</th><th>概要</th><th>详细纪要</th><th>关键词</th><th>操作</th></tr></thead>');
        const eventBody = $('<tbody></tbody>');
        for (const node of eventNodes) {
            eventBody.append(
                $('<tr></tr>')
                    .attr('data-memory-node-id', node.id)
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="title" />').val(node.title || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="location" placeholder="地点" />').val(node.location || ''),
                        $('<input class="text_pole m-t-05" type="text" data-memory-node-field="timeSpan" placeholder="时间跨度" />').val(node.timeSpan || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="summary" />').val(node.summary || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<textarea class="text_pole ai-wbr-memory-content" rows="3" data-memory-node-field="content"></textarea>').val(node.content || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="keys" placeholder="关键词，用逗号分隔" />').val((node.keys || []).join('，')),
                        $('<input class="text_pole m-t-05" type="text" data-memory-node-field="tags" placeholder="标签，用逗号分隔" />').val((node.tags || []).join('，')),
                    ))
                    .append($('<td></td>').append(
                        $('<div class="ai-wbr-memory-event-actions"></div>')
                            .append(createNodeTypeSelect('data-memory-node-field', node.type || 'event'))
                            .append($('<button class="menu_button ai-wbr-memory-delete-node" type="button">删除</button>')),
                    )),
            );
        }
        eventTable.append(eventBody);
        nodesContainer.append($('<div class="ai-wbr-memory-table-wrap"></div>').append(eventTable));
    }

    nodesContainer.append($('<div class="ai-wbr-memory-subtitle m-t-1"><b>非事件节点（角色 / 地点 / 概念等）</b></div>'));
    if (!nonEventNodes.length) {
        nodesContainer.append('<div class="ai-wbr-token-empty">暂无非事件节点</div>');
    } else {
        const nonEventTable = $('<table class="ai-wbr-memory-table ai-wbr-memory-entity-table"></table>');
        nonEventTable.append('<thead><tr><th>标题</th><th>类型</th><th>说明</th><th>关键词 / 标签</th><th>操作</th></tr></thead>');
        const nonEventBody = $('<tbody></tbody>');
        for (const node of nonEventNodes) {
            nonEventBody.append(
                $('<tr></tr>')
                    .attr('data-memory-node-id', node.id)
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="title" />').val(node.title || ''),
                    ))
                    .append($('<td></td>').append(
                        createNodeTypeSelect('data-memory-node-field', node.type || 'character'),
                    ))
                    .append($('<td></td>').append(
                        $('<textarea class="text_pole ai-wbr-memory-content" rows="3" data-memory-node-field="content"></textarea>').val(node.content || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="keys" placeholder="关键词，用逗号分隔" />').val((node.keys || []).join('，')),
                        $('<input class="text_pole m-t-05" type="text" data-memory-node-field="tags" placeholder="标签，用逗号分隔" />').val((node.tags || []).join('，')),
                    ))
                    .append($('<td></td>').append(
                        $('<button class="menu_button ai-wbr-memory-delete-node" type="button">删除</button>'),
                    )),
            );
        }
        nonEventTable.append(nonEventBody);
        nodesContainer.append($('<div class="ai-wbr-memory-table-wrap"></div>').append(nonEventTable));
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
                .toggleClass('ai-wbr-memory-link-card-selected', String(link.id) === String(memoryGraphSelectedLinkId))
                .append($('<div class="ai-wbr-memory-link-title"></div>').text(`${source} → ${target}`))
                .append($('<div class="ai-wbr-memory-link-grid"></div>')
                    .append(createLinkTypeSelect('data-memory-link-field', link.type || 'RELATED'))
                    .append($('<input class="text_pole" type="number" min="0" max="1" step="0.05" data-memory-link-field="weight" />').val(link.weight ?? 0.7))
                    .append($('<button class="menu_button ai-wbr-memory-delete-link" type="button">删除</button>')))
                .append($('<input class="text_pole" type="text" data-memory-link-field="description" placeholder="关系描述" />').val(link.description || '')),
        );
    }
}

function renderMemoryNodeEditor(graph) {
    const editor = $('#ai_wbr_memory_node_editor').empty();
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const selectedNode = nodes.find(node => node.id === memoryGraphSelectedNodeId) || null;
    const sourceTitle = memoryGraphLinkSourceId
        ? nodes.find(item => item.id === memoryGraphLinkSourceId)?.title || memoryGraphLinkSourceId
        : '';
    const hasRelatedLink = !!(memoryGraphLinkSourceId && selectedNode && memoryGraphLinkSourceId !== selectedNode.id
        && graph.links.some(item => item.source === memoryGraphLinkSourceId && item.target === selectedNode.id && item.type === 'RELATED'));

    editor.append('<div class="ai-wbr-memory-subtitle"><b>节点编辑器</b></div>');

    if (!selectedNode) {
        editor.append('<div class="ai-wbr-token-empty">点击上方图谱节点后，这里会显示该节点的可编辑信息。</div>');
        return;
    }

    editor
        .attr('data-memory-node-id', selectedNode.id)
        .append(
            $('<div class="ai-wbr-memory-node-editor-card"></div>')
                .append($('<div class="ai-wbr-memory-node-editor-title"></div>').text(selectedNode.title || selectedNode.id))
                .append($('<div class="ai-wbr-memory-node-editor-grid"></div>')
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>标题</span>')
                            .append($('<input class="text_pole" type="text" data-memory-editor-field="title" />').val(selectedNode.title || '')),
                    )
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>类型</span>')
                            .append(createNodeTypeSelect('data-memory-editor-field', selectedNode.type || 'event')),
                    )
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field ai-wbr-memory-node-editor-field-wide"></label>')
                            .append('<span>内容</span>')
                            .append($('<textarea class="text_pole" rows="4" data-memory-editor-field="content"></textarea>').val(selectedNode.content || '')),
                    )
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>关键词</span>')
                            .append($('<input class="text_pole" type="text" data-memory-editor-field="keys" placeholder="用逗号分隔" />').val((selectedNode.keys || []).join('，'))),
                    )
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>标签</span>')
                            .append($('<input class="text_pole" type="text" data-memory-editor-field="tags" placeholder="用逗号分隔" />').val((selectedNode.tags || []).join('，'))),
                    ),
                )
                .append(
                    $('<div class="ai-wbr-memory-popover-actions"></div>')
                        .append('<button class="menu_button ai-wbr-memory-editor-save" type="button">保存</button>')
                        .append('<button class="menu_button ai-wbr-memory-editor-set-link-source" type="button">设为起点</button>')
                        .append($(`<button class="menu_button ai-wbr-memory-editor-link-to-source" type="button" ${memoryGraphLinkSourceId && memoryGraphLinkSourceId !== selectedNode.id ? '' : 'disabled'}>${hasRelatedLink ? '取消连线' : '连接到起点'}${sourceTitle ? `：${escapeHtml(truncateText(sourceTitle, 10))}` : ''}</button>`))
                        .append('<button class="menu_button ai-wbr-memory-editor-delete" type="button">删除</button>'),
                ),
        );
}

function renderMemoryEdgeEditor(graph) {
    const editor = $('#ai_wbr_memory_edge_editor').empty();
    const links = Array.isArray(graph?.links) ? graph.links : [];
    const selectedLink = links.find(link => String(link.id) === String(memoryGraphSelectedLinkId)) || null;
    editor.append('<div class="ai-wbr-memory-subtitle"><b>关系编辑器</b></div>');

    if (!selectedLink) {
        editor.append('<div class="ai-wbr-token-empty">点击图上的关系线，或下方关系卡片后，这里会显示该关系的可编辑信息。</div>');
        return;
    }

    const sourceTitle = graph.nodes.find(node => node.id === selectedLink.source)?.title || selectedLink.source;
    const targetTitle = graph.nodes.find(node => node.id === selectedLink.target)?.title || selectedLink.target;

    editor.append(
        $('<div class="ai-wbr-memory-node-editor-card"></div>')
            .attr('data-memory-link-id', selectedLink.id)
            .append($('<div class="ai-wbr-memory-node-editor-title"></div>').text(`${sourceTitle} → ${targetTitle}`))
                .append($('<div class="ai-wbr-memory-node-editor-grid"></div>')
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>关系类型</span>')
                            .append(createLinkTypeSelect('data-memory-edge-field', selectedLink.type || 'RELATED')),
                    )
                .append(
                    $('<label class="ai-wbr-memory-node-editor-field"></label>')
                        .append('<span>权重</span>')
                        .append($('<input class="text_pole" type="number" min="0" max="1" step="0.05" data-memory-edge-field="weight" />').val(selectedLink.weight ?? 0.7)),
                )
                .append(
                    $('<label class="ai-wbr-memory-node-editor-field ai-wbr-memory-node-editor-field-wide"></label>')
                        .append('<span>关系描述</span>')
                        .append($('<textarea class="text_pole" rows="3" data-memory-edge-field="description"></textarea>').val(selectedLink.description || '')),
                ),
            )
            .append(
                $('<div class="ai-wbr-memory-popover-actions"></div>')
                    .append('<button class="menu_button ai-wbr-memory-edge-save" type="button">保存</button>')
                    .append('<button class="menu_button ai-wbr-memory-edge-delete" type="button">删除这条线</button>'),
            ),
    );
}

function bindMemoryPanelActions() {
    const bookshelfSection = $('#ai_wbr_bookshelf_panel').closest('#ai_wbr_bookshelf_section, .ai-wbr-bookshelf-fold');
    if (bookshelfSection.length) {
        ensureBookshelfStandaloneControls(bookshelfSection);
    }

    bindCheckbox('#ai_wbr_memory_enabled', 'memoryEnabled');
    bindCheckbox('#ai_wbr_memory_auto_run', 'memoryRealtimeEnabled');
    bindCheckbox('#ai_wbr_memory_realtime_enabled', 'memoryRealtimeEnabled');
    bindCheckbox('#ai_wbr_memory_summary_enabled', 'memorySummaryEnabled');
    bindCheckbox('#ai_wbr_memory_inject_to_router', 'memoryInjectToRouter');
    bindCheckbox('#ai_wbr_memory_review_required', 'memoryReviewRequired');
    bindCheckbox('#ai_wbr_memory_debug', 'memoryDebug');
    bindCheckbox('#ai_wbr_memory_scope_debug', 'memoryScopeDebug');
    bindCheckbox('#ai_wbr_memory_history_skip_done', 'memoryHistorySkipDone');
    bindCheckbox('#ai_wbr_bookshelf_enabled', 'bookshelfEnabled');
    bindCheckbox('#ai_wbr_bookshelf_auto_inject', 'bookshelfAutoInject');
    bindCheckbox('#ai_wbr_bookshelf_auto_memory_book', 'bookshelfAutoMemoryBook');
    bindCheckbox('#ai_wbr_bookshelf_memory_vector', 'bookshelfMemoryVectorRecall');
    bindCheckbox('#ai_wbr_bookshelf_only_bound', 'bookshelfOnlyBound');
    bindCheckbox('#ai_wbr_bookshelf_allow_global', 'bookshelfAllowGlobal');
    bindNumber('#ai_wbr_memory_auto_run_interval', 'memorySummaryIntervalMessages', 1, 100);
    bindNumber('#ai_wbr_memory_scan_messages', 'memorySummaryScanMessages', 2, 40);
    bindNumber('#ai_wbr_memory_realtime_scan_messages', 'memoryRealtimeScanMessages', 2, 40);
    bindNumber('#ai_wbr_memory_summary_interval_messages', 'memorySummaryIntervalMessages', 1, 100);
    bindNumber('#ai_wbr_memory_summary_scan_messages', 'memorySummaryScanMessages', 2, 40);
    bindNumber('#ai_wbr_memory_retries', 'memoryRetries', 0, 10);
    bindNumber('#ai_wbr_memory_max_nodes', 'memoryMaxNodes', 5, 200);
    bindNumber('#ai_wbr_memory_max_links', 'memoryMaxLinks', 0, 400);
    bindNumber('#ai_wbr_bookshelf_memory_vector_max', 'bookshelfMemoryVectorMaxItems', 1, 12);
    bindNumber('#ai_wbr_bookshelf_max_chunks', 'bookshelfMaxChunks', 1, 12);
    bindNumber('#ai_wbr_bookshelf_max_chars', 'bookshelfMaxChunkChars', 120, 2000);
    bindNumber('#ai_wbr_bookshelf_min_score', 'bookshelfMinScore', 0, 1);

    bindText('#ai_wbr_bookshelf_api_url', 'bookshelfApiUrl', normalizeUrl);
    bindText('#ai_wbr_bookshelf_api_key', 'bookshelfApiKey', (value) => String(value).trim());
    $('#ai_wbr_bookshelf_api_model').on('change', function () {
        saveSetting('bookshelfApiModel', String($(this).val() || '').trim());
        syncBookshelfProviderVisibility();
    });
    bindText('#ai_wbr_bookshelf_local_model', 'bookshelfLocalModelId', (value) => String(value).trim());

    $('#ai_wbr_bookshelf_embedding_mode')
        .val(getBookshelfEmbeddingMode())
        .on('change', function () {
            saveSetting('bookshelfEmbeddingMode', String($(this).val() || 'api') === 'browser-local' ? 'browser-local' : 'api');
            syncBookshelfProviderVisibility();
            renderBookshelfPanel();
        });

    $('#ai_wbr_bookshelf_enabled, #ai_wbr_bookshelf_auto_inject, #ai_wbr_bookshelf_auto_memory_book, #ai_wbr_bookshelf_memory_vector, #ai_wbr_bookshelf_only_bound, #ai_wbr_bookshelf_allow_global, #ai_wbr_bookshelf_memory_vector_max, #ai_wbr_bookshelf_max_chunks, #ai_wbr_bookshelf_max_chars, #ai_wbr_bookshelf_min_score, #ai_wbr_bookshelf_api_url, #ai_wbr_bookshelf_api_key, #ai_wbr_bookshelf_api_model, #ai_wbr_bookshelf_local_model')
        .on('input change', () => {
            syncBookshelfProviderVisibility();
            renderBookshelfPanel();
        });
    bindBookshelfDynamicSettingsActions();
    syncBookshelfProviderVisibility();

    $('#ai_wbr_memory_history_mode')
        .val(settings.memoryHistoryMode || 'history')
        .on('change', function () {
            const nextMode = String($(this).val() || 'history');
            saveSetting('memoryHistoryMode', ['history', 'summary'].includes(nextMode) ? nextMode : 'history');
        });

    $('[data-ai-wbr-history-range]').on('click', function (event) {
        event.preventDefault();
        const context = getContext();
        const messages = getAllMemoryMessages(Array.isArray(context?.chat) ? context.chat : []);
        const maxFloor = messages.length ? Math.max(...messages.map(message => message.floor)) : 0;
        const range = String($(this).data('aiWbrHistoryRange') || '');
        if (!maxFloor) {
            setHistoryImportRange(1, 1, context);
            return;
        }
        if (range === 'all') {
            setHistoryImportRange(1, maxFloor, context);
            return;
        }
        const count = clampNumber(Number(range), 20, 1, 100000);
        setHistoryImportRange(Math.max(1, maxFloor - count + 1), maxFloor, context);
    });

    $('#ai_wbr_memory_history_start_floor, #ai_wbr_memory_history_end_floor').on('input change', () => {
        buildHistoryImportPreview(getHistoryImportRangeFromUi(), getContext());
    });

    $('#ai_wbr_memory_history_preview').on('click', (event) => {
        event.preventDefault();
        buildHistoryImportPreview(getHistoryImportRangeFromUi(), getContext());
    });

    $('#ai_wbr_memory_history_import').on('click', async (event) => {
        event.preventDefault();
        await runHistoryMemoryImport();
    });

    $('#ai_wbr_memory_run_now').on('click', async (event) => {
        event.preventDefault();
        await runMemoryGraphUpdate('manual', {
            mode: 'realtime',
            scanMessages: settings.memoryRealtimeScanMessages,
            force: true,
            review: false,
        });
    });

    $('#ai_wbr_memory_summary_now').on('click', async (event) => {
        event.preventDefault();
        await runMemoryGraphUpdate('manual_summary', {
            mode: 'summary',
            scanMessages: settings.memorySummaryScanMessages,
            force: true,
            review: false,
        });
    });

    $('#ai_wbr_memory_accept_all').on('click', (event) => {
        event.preventDefault();
        const accepted = acceptAllMemoryReviews();
        if (accepted.count) {
            setMemoryStatus(`已确认 ${accepted.count} 条记忆更新`);
            toastr?.success?.('Done.', 'AI Worldbook Router');
        }
        renderMemoryPanel();
    });

    $('#ai_wbr_memory_reject_all').on('click', (event) => {
        event.preventDefault();
        const count = clearMemoryReviewQueue();
        if (count) {
            setMemoryStatus(`已清空 ${count} 条待确认更新`);
            toastr?.info?.('Done.', 'AI Worldbook Router');
        }
        renderMemoryPanel();
    });

    $('#ai_wbr_memory_save_json').on('click', (event) => {
        event.preventDefault();
        try {
            const parsed = JSON.parse(String($('#ai_wbr_memory_json').val() || '{}'));
            const nextGraph = {
                ...getDefaultMemoryGraph(),
                ...parsed,
            };
            saveMemoryGraph(nextGraph);
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
        saveMemoryGraph(getDefaultMemoryGraph());
        setCurrentMemoryLastTurnSignature('');
        setCurrentMemoryLastPrompt('');
        setCurrentMemoryLastRaw('');
        setCurrentMemoryLastError('');
        setMemoryStatus('已清空');
    });

    $(document).off('click.aiWbrBookshelfImport', '#ai_wbr_bookshelf_import').on('click.aiWbrBookshelfImport', '#ai_wbr_bookshelf_import', (event) => {
        event.preventDefault();
        const panel = $(event.currentTarget).closest('#ai_wbr_bookshelf_panel');
        const fileInput = panel.find('#ai_wbr_bookshelf_file').first();
        (fileInput[0] || $('#ai_wbr_bookshelf_file')[0])?.click?.();
    });

    $(document).off('click.aiWbrBookshelfDrawer', '#ai_wbr_bookshelf_open_settings, #ai_wbr_bookshelf_close_settings, #ai_wbr_bookshelf_settings_backdrop')
        .on('click.aiWbrBookshelfDrawer', '#ai_wbr_bookshelf_open_settings', (event) => {
            event.preventDefault();
            const panel = $(event.currentTarget).closest('#ai_wbr_bookshelf_panel');
            panel.find('#ai_wbr_bookshelf_settings_drawer').addClass('open').attr('aria-hidden', 'false');
            panel.find('#ai_wbr_bookshelf_settings_backdrop').addClass('open');
        })
        .on('click.aiWbrBookshelfDrawer', '#ai_wbr_bookshelf_close_settings, #ai_wbr_bookshelf_settings_backdrop', (event) => {
            event.preventDefault();
            const panel = $(event.currentTarget).closest('#ai_wbr_bookshelf_panel');
            panel.find('#ai_wbr_bookshelf_settings_drawer').removeClass('open').attr('aria-hidden', 'true');
            panel.find('#ai_wbr_bookshelf_settings_backdrop').removeClass('open');
        });

    $(document).off('change.aiWbrBookshelfFile', '#ai_wbr_bookshelf_file').on('change.aiWbrBookshelfFile', '#ai_wbr_bookshelf_file', async function () {
        try {
            await importBookshelfFiles(this.files);
        } catch (error) {
            setBookshelfStatus(`导入失败：${error?.message || error}`);
            toastr?.error?.('Operation failed.', 'AI Worldbook Router');
        } finally {
            this.value = '';
        }
    });

    $(document).off('click.aiWbrBookshelfTestOpen', '#ai_wbr_bookshelf_test_open').on('click.aiWbrBookshelfTestOpen', '#ai_wbr_bookshelf_test_open', (event) => {
        event.preventDefault();
        const panel = $(event.currentTarget).closest('#ai_wbr_bookshelf_panel');
        panel.find('#ai_wbr_bookshelf_test_panel').toggleClass('open');
    });

    $(document).off('click.aiWbrBookshelfTest', '#ai_wbr_bookshelf_test').on('click.aiWbrBookshelfTest', '#ai_wbr_bookshelf_test', async (event) => {
        event.preventDefault();
        const panel = $(event.currentTarget).closest('#ai_wbr_bookshelf_panel');
        const query = String(panel.find('#ai_wbr_bookshelf_test_query').val() || '').trim();
        saveSetting('bookshelfLastTestQuery', query);
        if (!query) {
            setBookshelfStatus('请输入测试句子。');
            return;
        }
        try {
            setBookshelfStatus('正在测试统一向量召回...');
            const context = getContext();
            const memoryGraph = getMemoryGraph(context);
            const result = await recallVectorMemoryAndBookshelf(query, memoryGraph, context, { force: true });
            bookshelfLastTestResults = [
                ...(result.selectedMemoryVectors || []),
                ...(result.selectedBookshelf || []),
            ];
            const graphHits = result.selectedMemoryVectors?.length || 0;
            const txtHits = result.selectedBookshelf?.length || 0;
            const graphCandidates = result.memoryCandidates?.length || 0;
            const txtCandidates = result.bookshelfCandidates?.length || 0;
            setBookshelfStatus(`测试完成：图谱候选 ${graphCandidates} 条，命中 ${graphHits} 条；TXT 候选 ${txtCandidates} 条，命中 ${txtHits} 条。`);
            renderBookshelfPanel();
        } catch (error) {
            bookshelfLastTestResults = [];
            setBookshelfStatus(`测试失败：${error?.message || error}`);
            renderBookshelfPanel();
        }
    });

    $(document).off('click.aiWbrBookshelfProvider', '#ai_wbr_bookshelf_test_provider').on('click.aiWbrBookshelfProvider', '#ai_wbr_bookshelf_test_provider', async (event) => {
        event.preventDefault();
        try {
            setBookshelfModelStatus('正在测试...');
            const vector = await embedBookshelfText('测试书架向量模型连接。');
            setBookshelfModelStatus(`可用，维度 ${vector.length}`);
            toastr?.success?.('Done.', 'AI Worldbook Router');
        } catch (error) {
            setBookshelfModelStatus(`失败：${error?.message || error}`);
            toastr?.error?.('Operation failed.', 'AI Worldbook Router');
        }
    });

    $(document).off('click.aiWbrBookshelfFetchModels', '#ai_wbr_bookshelf_fetch_models').on('click.aiWbrBookshelfFetchModels', '#ai_wbr_bookshelf_fetch_models', async (event) => {
        event.preventDefault();
        try {
            saveSetting('bookshelfEmbeddingMode', 'api');
            $('#ai_wbr_bookshelf_embedding_mode').val('api');
            await fetchBookshelfApiModels();
            syncBookshelfProviderVisibility();
        } catch (error) {
            setBookshelfModelStatus(`获取失败：${error?.message || error}`);
            toastr?.error?.('Operation failed.', 'AI Worldbook Router');
        }
    });

    $(document).off('click.aiWbrBookshelfLocal', '#ai_wbr_bookshelf_load_local').on('click.aiWbrBookshelfLocal', '#ai_wbr_bookshelf_load_local', async (event) => {
        event.preventDefault();
        try {
            saveSetting('bookshelfEmbeddingMode', 'browser-local');
            $('#ai_wbr_bookshelf_embedding_mode').val('browser-local');
            syncBookshelfProviderVisibility();
            setBookshelfModelStatus('正在下载/加载本地模型...');
            await getBookshelfLocalEmbeddingPipeline();
            setBookshelfModelStatus('本地模型已缓存并可用');
            toastr?.success?.('Done.', 'AI Worldbook Router');
        } catch (error) {
            setBookshelfModelStatus(`失败：${error?.message || error}`);
            toastr?.error?.('Operation failed.', 'AI Worldbook Router');
        }
    });

    $(document).off('click.aiWbrBookshelfMemoryVectorize', '#ai_wbr_bookshelf_vectorize_memory').on('click.aiWbrBookshelfMemoryVectorize', '#ai_wbr_bookshelf_vectorize_memory', async (event) => {
        event.preventDefault();
        try {
            setBookshelfStatus('正在同步图谱记忆向量...');
            const result = await syncMemoryGraphVectors(getMemoryGraph(), getContext(), { force: true });
            setBookshelfStatus(`图谱向量同步完成：节点 ${result.total} 个，可用 ${result.ready} 个，失败 ${result.failed} 个。`);
            toastr?.success?.('Done.', 'AI Worldbook Router');
            renderBookshelfPanel();
        } catch (error) {
            setBookshelfStatus(`图谱向量同步失败：${error?.message || error}`);
            toastr?.error?.('Operation failed.', 'AI Worldbook Router');
            renderBookshelfPanel();
        }
    });

    $(document).off('click.aiWbrBookshelfBuildMemoryBooks', '#ai_wbr_bookshelf_build_memory_books').on('click.aiWbrBookshelfBuildMemoryBooks', '#ai_wbr_bookshelf_build_memory_books', async (event) => {
        event.preventDefault();
        try {
            setBookshelfStatus('正在从图谱拆分并生成自动记忆书...');
            const result = await syncMemoryGraphBookshelfBooks(getMemoryGraph(), getContext(), { vectorize: false });
            selectedBookshelfBookId = result.bookIds?.[0] || selectedBookshelfBookId;
            bookshelfLastTestResults = [];
            const provider = getBookshelfEmbeddingProviderMeta();
            if (provider.model && result.bookIds?.length) {
                for (const bookId of result.bookIds) {
                    await rebuildBookshelfBookVectors(bookId);
                }
                setBookshelfStatus(`自动记忆书已生成并向量化：${result.books} 本，${result.chunks} 个摘要片段；已替换旧书 ${result.deleted} 本。`);
            } else {
                setBookshelfStatus(`自动记忆书已生成：${result.books} 本，${result.chunks} 个摘要片段；配置向量模型后点击书籍“开始向量化”。`);
            }
            toastr?.success?.('Memory books generated.', 'AI Worldbook Router');
            renderBookshelfPanel();
        } catch (error) {
            setBookshelfStatus(`生成记忆书失败：${error?.message || error}`);
            toastr?.error?.('Operation failed.', 'AI Worldbook Router');
            renderBookshelfPanel();
        }
    });

    $(document).off('click.aiWbrBookshelfMemoryReset', '#ai_wbr_bookshelf_reset_memory_vectors').on('click.aiWbrBookshelfMemoryReset', '#ai_wbr_bookshelf_reset_memory_vectors', async (event) => {
        event.preventDefault();
        if (!confirm('确定重置当前聊天的图谱记忆向量索引？不会删除图谱本身。')) return;
        try {
            await bookshelfDeleteMemoryVectorsForChat(getCurrentChatMemoryKey());
            setBookshelfStatus('当前聊天的图谱记忆向量已重置。');
            bookshelfLastTestResults = [];
            renderBookshelfPanel();
        } catch (error) {
            setBookshelfStatus(`图谱向量重置失败：${error?.message || error}`);
            toastr?.error?.('Operation failed.', 'AI Worldbook Router');
        }
    });
    function getBookshelfActionBookId(button) {
        return String(
            $(button).data('bookshelfBookId')
            || $(button).closest('[data-bookshelf-book-id]').data('bookshelfBookId')
            || selectedBookshelfBookId
            || ''
        );
    }

    $(document)
        .off('.aiWbrBookshelf')
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-book', function (event) {
            if ($(event.target).closest('button').length && !$(event.target).closest('.ai-wbr-bookshelf-cover').length) return;
            event.preventDefault();
            selectedBookshelfBookId = String($(this).data('bookshelfBookId') || '');
            renderBookshelfPanel();
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-select', async function (event) {
            event.preventDefault();
            event.stopPropagation();
            selectedBookshelfBookId = String($(this).closest('[data-bookshelf-book-id]').data('bookshelfBookId') || '');
            const book = await bookshelfGet('books', selectedBookshelfBookId);
            if (book?.autoGenerated && book?.autoSource === 'memory-graph') {
                await openBookshelfNovelReader(selectedBookshelfBookId);
            } else {
                renderBookshelfPanel();
            }
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-open-reader', async function (event) {
            event.preventDefault();
            event.stopPropagation();
            await openBookshelfNovelReader(getBookshelfActionBookId(this));
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-reader-close, .ai-wbr-bookshelf-reader-overlay', function (event) {
            if ($(event.target).closest('.ai-wbr-bookshelf-reader-shell').length && !$(event.target).closest('.ai-wbr-bookshelf-reader-close').length) return;
            event.preventDefault();
            $('.ai-wbr-bookshelf-reader-overlay').remove();
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-reader-toc-item', function (event) {
            event.preventDefault();
            const button = $(this);
            const chapterTitle = String(button.data('bookshelfChapterTitle') || '');
            const shell = button.closest('.ai-wbr-bookshelf-reader-shell');
            const pages = shell.find('.ai-wbr-bookshelf-reader-pages');
            const target = pages.find('.ai-wbr-bookshelf-reader-page').filter(function () {
                return String($(this).data('bookshelfChapterTitle') || '') === chapterTitle;
            }).first();
            button.siblings('.ai-wbr-bookshelf-reader-toc-item').removeClass('active');
            button.addClass('active');
            if (target.length && pages.length) {
                pages.stop(true).animate({ scrollTop: pages.scrollTop() + target.position().top - 8 }, 160);
            }
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-toc-item', function (event) {
            event.preventDefault();
            const button = $(this);
            const chapterTitle = String(button.data('bookshelfChapterTitle') || '');
            const detail = button.closest('.ai-wbr-bookshelf-selected-detail');
            const pages = detail.find('.ai-wbr-bookshelf-novel-pages');
            const target = pages.find('.ai-wbr-bookshelf-page').filter(function () {
                return String($(this).data('bookshelfChapterTitle') || '') === chapterTitle;
            }).first();
            button.siblings('.ai-wbr-bookshelf-toc-item').removeClass('active');
            button.addClass('active');
            if (target.length && pages.length) {
                pages.stop(true).animate({ scrollTop: pages.scrollTop() + target.position().top - 8 }, 160);
            }
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-toggle', async function (event) {
            event.preventDefault();
            const bookId = getBookshelfActionBookId(this);
            const book = await bookshelfGet('books', bookId);
            if (!book) return;
            await updateBookshelfBook(bookId, { enabled: book.enabled === false });
            renderBookshelfPanel();
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-rebuild', async function (event) {
            event.preventDefault();
            const bookId = getBookshelfActionBookId(this);
            try {
                await rebuildBookshelfBookVectors(bookId);
            } catch (error) {
                setBookshelfStatus(`向量化失败：${error?.message || error}`);
            }
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-clear-vector', async function (event) {
            event.preventDefault();
            const bookId = getBookshelfActionBookId(this);
            if (!bookId || !confirm('确定重置这本书的所有向量并回到待向量化？')) return;
            await clearBookshelfBookVectors(bookId);
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-delete', async function (event) {
            event.preventDefault();
            event.stopPropagation();
            const bookId = getBookshelfActionBookId(this);
            if (!bookId) return;
            setBookshelfStatus('\u6b63\u5728\u5220\u9664\u4e66\u7c4d...');
            await bookshelfDeleteBook(bookId);
            if (selectedBookshelfBookId === bookId) selectedBookshelfBookId = '';
            bookshelfLastTestResults = [];
            setBookshelfStatus('\u4e66\u7c4d\u5df2\u5220\u9664\u3002');
            renderBookshelfPanel();
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-bind-character', async function (event) {
            event.preventDefault();
            const bookId = getBookshelfActionBookId(this);
            const book = await bookshelfGet('books', bookId);
            const scope = getBookshelfScope();
            if (isBookshelfBookBound(book, 'character', scope.characterKey)) {
                await removeBookshelfBinding(bookId, 'character');
            } else {
                await setBookshelfBinding(bookId, 'character');
            }
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-bind-chat', async function (event) {
            event.preventDefault();
            const bookId = getBookshelfActionBookId(this);
            const book = await bookshelfGet('books', bookId);
            const scope = getBookshelfScope();
            if (isBookshelfBookBound(book, 'chat', scope.chatKey)) {
                await removeBookshelfBinding(bookId, 'chat');
            } else {
                await setBookshelfBinding(bookId, 'chat');
            }
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-bind-global', async function (event) {
            event.preventDefault();
            const bookId = getBookshelfActionBookId(this);
            const book = await bookshelfGet('books', bookId);
            if (isBookshelfBookBound(book, 'global', 'global')) {
                await removeBookshelfBinding(bookId, 'global');
            } else {
                await setBookshelfBinding(bookId, 'global');
            }
        })
        .on('click.aiWbrBookshelf', '.ai-wbr-bookshelf-clear-bindings', async function (event) {
            event.preventDefault();
            const bookId = getBookshelfActionBookId(this);
            await clearBookshelfBindings(bookId);
        });

    $(document)
        .off('.aiWbrGraphWorkspace')
        .on('click.aiWbrGraphWorkspace', '#ai_wbr_memory_graph_fit', (event) => {
            event.preventDefault();
            const graph = getMemoryGraph();
            fitMemoryGraphToContainer(graph);
            renderMemoryGraphSvg(graph);
        })
        .on('click.aiWbrGraphWorkspace', '#ai_wbr_memory_graph_fullscreen, .ai-wbr-memory-open-fullscreen', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setMemoryGraphFullscreen(!memoryGraphFullscreenActive);
        })
        .on('click.aiWbrGraphWorkspace', '#ai_wbr_memory_graph_close_detail, .ai-wbr-memory-detail-close', (event) => {
            event.preventDefault();
            memoryGraphSelectedNodeId = '';
            memoryGraphSelectedLinkId = '';
            memoryGraphDetailMode = '';
            renderMemoryPanel('graph');
        })
        .on('click.aiWbrGraphWorkspace', '.ai-wbr-memory-detail-related-link', function (event) {
            event.preventDefault();
            memoryGraphSelectedLinkId = String($(this).data('memoryLinkId') || '');
            memoryGraphSelectedNodeId = '';
            memoryGraphDetailMode = 'link';
            renderMemoryPanel('graph');
        })
        .on('click.aiWbrGraphWorkspace', '.ai-wbr-memory-detail-set-link-source', function (event) {
            event.preventDefault();
            memoryGraphLinkSourceId = String($(this).data('memoryNodeId') || '');
            renderMemoryPanel('graph');
        })
        .on('click.aiWbrGraphWorkspace', '.ai-wbr-memory-detail-link-to-source', function (event) {
            event.preventDefault();
            const targetId = String($(this).data('memoryNodeId') || '');
            if (!memoryGraphLinkSourceId || memoryGraphLinkSourceId === targetId) {
                return;
            }
            const graph = getMemoryGraph();
            const existingIndex = graph.links.findIndex(item => item.source === memoryGraphLinkSourceId && item.target === targetId && item.type === 'RELATED');
            if (existingIndex >= 0) {
                graph.links.splice(existingIndex, 1);
            } else {
                const link = normalizeMemoryLink({
                    source: memoryGraphLinkSourceId,
                    target: targetId,
                    type: 'RELATED',
                    weight: 0.7,
                    description: '手动创建的记忆关系',
                }, new Set(graph.nodes.map(node => node.id)), graph.links.length);
                if (link) {
                    graph.links.push(link);
                }
            }
            memoryGraphLinkSourceId = '';
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
            renderMemoryPanel('graph');
        })
        .on('click.aiWbrGraphWorkspace', '.ai-wbr-memory-detail-delete-node', function (event) {
            event.preventDefault();
            const nodeId = String($(this).data('memoryNodeId') || '');
            const graph = getMemoryGraph();
            graph.nodes = graph.nodes.filter(node => node.id !== nodeId);
            graph.links = graph.links.filter(link => link.source !== nodeId && link.target !== nodeId);
            memoryGraphSelectedNodeId = '';
            memoryGraphDetailMode = '';
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
            renderMemoryPanel('graph');
        })
        .on('click.aiWbrGraphWorkspace', '.ai-wbr-memory-detail-delete-link', function (event) {
            event.preventDefault();
            const linkId = String($(this).data('memoryLinkId') || '');
            const graph = getMemoryGraph();
            graph.links = graph.links.filter(link => String(link.id) !== linkId);
            memoryGraphSelectedLinkId = '';
            memoryGraphDetailMode = '';
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
            renderMemoryPanel('graph');
        });

    $('#ai_worldbook_router_settings')
        .on('click', '#ai_wbr_memory_node_popover, #ai_wbr_memory_node_popover *', function (event) {
            event.stopPropagation();
        })
        .on('click', '.ai-wbr-memory-review-accept', function () {
            const id = String($(this).closest('[data-memory-review-id]').data('memoryReviewId') || '');
            const result = acceptMemoryReviewItem(id);
            if (result) {
                setMemoryStatus(`已确认：${result.graph.nodes.length} 节点 / ${result.graph.links.length} 关系`);
                toastr?.success?.('Done.', 'AI Worldbook Router');
            }
            renderMemoryPanel();
        })
        .on('click', '.ai-wbr-memory-review-reject', function () {
            const id = String($(this).closest('[data-memory-review-id]').data('memoryReviewId') || '');
            rejectMemoryReviewItem(id);
            setMemoryStatus('已忽略 1 条待确认更新');
            renderMemoryPanel();
        })
        .on('input change', '[data-memory-state-field]', function () {
            const graph = getMemoryGraph();
            const field = String($(this).data('memoryStateField'));
            const value = String($(this).val() || '').trim();
            if (field === 'active_topics' || field === 'open_questions') {
                graph.state[field] = uniqueStrings(value.split(/[,\n，、]+/u)).slice(0, 12);
            } else if (field.startsWith('custom_')) {
                graph.state.custom_values = graph.state.custom_values && typeof graph.state.custom_values === 'object'
                    ? graph.state.custom_values
                    : {};
                graph.state.custom_values[field] = truncateText(value, 220);
            } else {
                graph.state[field] = value;
            }
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
            renderMemoryGraphSvg(graph);
        })
        .on('click', '#ai_wbr_memory_add_state_definition', function () {
            const graph = getMemoryGraph();
            const label = String($('#ai_wbr_memory_new_state_label').val() || '').trim();
            const instruction = String($('#ai_wbr_memory_new_state_instruction').val() || '').trim();
            if (!label) {
                toastr.warning('请先填写字段名', '世界书读取');
                return;
            }
            const definition = normalizeMemoryStateDefinition({ label, instruction }, getCustomMemoryStateDefinitions(graph).length);
            graph.stateDefinitions = getCustomMemoryStateDefinitions(graph);
            if (graph.stateDefinitions.some(item => item.key === definition.key || item.label === definition.label)) {
                toastr.warning('已存在同名或同 key 的状态字段', '世界书读取');
                return;
            }
            graph.stateDefinitions.push(definition);
            graph.state.custom_values = graph.state.custom_values && typeof graph.state.custom_values === 'object'
                ? graph.state.custom_values
                : {};
            graph.state.custom_values[definition.key] = '';
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
            $('#ai_wbr_memory_new_state_label').val('');
            $('#ai_wbr_memory_new_state_instruction').val('');
        })
        .on('click', '.ai-wbr-memory-delete-state-definition', function () {
            const graph = getMemoryGraph();
            const key = String($(this).data('memoryStateDefinitionKey') || '');
            graph.stateDefinitions = getCustomMemoryStateDefinitions(graph).filter(item => item.key !== key);
            if (graph.state.custom_values && typeof graph.state.custom_values === 'object') {
                delete graph.state.custom_values[key];
            }
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
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
            } else if (field === 'keys') {
                node.keys = uniqueStrings(value.split(/[,\n，、]+/u));
            } else if (field === 'title' || field === 'type' || field === 'content') {
                node[field] = value;
            } else if (field === 'summary' || field === 'location' || field === 'timeSpan') {
                node[field] = value.trim();
            }
            node.updatedAt = new Date().toISOString();
            graph.updatedAt = node.updatedAt;
            saveMemoryGraph(graph);
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
            saveMemoryGraph(graph);
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
            renderMemoryGraphSvg(graph);
        })
        .on('click', '.ai-wbr-memory-link-card', function (event) {
            if ($(event.target).closest('input, textarea, button, select').length) {
                return;
            }
            memoryGraphSelectedLinkId = String($(this).data('memoryLinkId') || '');
            renderMemoryPanel();
        })
        .on('input change', '[data-memory-edge-field]', function () {
            const graph = getMemoryGraph();
            const link = graph.links.find(item => String(item.id) === String(memoryGraphSelectedLinkId));
            if (!link) {
                return;
            }
            const field = String($(this).data('memoryEdgeField'));
            if (field === 'weight') {
                link.weight = clampNumber($(this).val(), link.weight || 0.7, 0, 1);
            } else {
                link[field] = String($(this).val() || '');
            }
            link.updatedAt = new Date().toISOString();
            graph.updatedAt = link.updatedAt;
            saveMemoryGraph(graph);
        })
        .on('click', '.ai-wbr-memory-edge-save', function () {
            const graph = getMemoryGraph();
            const link = graph.links.find(item => String(item.id) === String(memoryGraphSelectedLinkId));
            if (!link) {
                return;
            }
            link.updatedAt = new Date().toISOString();
            graph.updatedAt = link.updatedAt;
            saveMemoryGraph(graph);
            toastr.success('关系已保存', '世界书读取');
        })
        .on('click', '.ai-wbr-memory-edge-delete', function () {
            const graph = getMemoryGraph();
            const id = String(memoryGraphSelectedLinkId || '');
            graph.links = graph.links.filter(link => String(link.id) !== id);
            memoryGraphSelectedLinkId = '';
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
        })
        .on('input change', '[data-memory-editor-field]', function () {
            const graph = getMemoryGraph();
            const node = graph.nodes.find(item => item.id === memoryGraphSelectedNodeId);
            if (!node) {
                return;
            }
            const field = String($(this).data('memoryEditorField'));
            const value = String($(this).val() || '');
            if (field === 'tags') {
                node.tags = uniqueStrings(value.split(/[,\n，、]+/u));
            } else if (field === 'keys') {
                node.keys = uniqueStrings(value.split(/[,\n，、]+/u));
            } else {
                node[field] = value;
            }
            node.updatedAt = new Date().toISOString();
            graph.updatedAt = node.updatedAt;
            saveMemoryGraph(graph);
        })
        .on('click', '.ai-wbr-memory-editor-save', function () {
            const graph = getMemoryGraph();
            const node = graph.nodes.find(item => item.id === memoryGraphSelectedNodeId);
            if (!node) {
                return;
            }
            node.updatedAt = new Date().toISOString();
            graph.updatedAt = node.updatedAt;
            saveMemoryGraph(graph);
            toastr.success('节点已保存', '世界书读取');
        })
        .on('click', '.ai-wbr-memory-editor-set-link-source', function () {
            if (!memoryGraphSelectedNodeId) {
                return;
            }
            memoryGraphLinkSourceId = memoryGraphSelectedNodeId;
            renderMemoryPanel();
        })
        .on('click', '.ai-wbr-memory-editor-link-to-source', function () {
            const graph = getMemoryGraph();
            const targetId = memoryGraphSelectedNodeId;
            if (!memoryGraphLinkSourceId || !targetId || memoryGraphLinkSourceId === targetId) {
                return;
            }
            const existingIndex = graph.links.findIndex(item => item.source === memoryGraphLinkSourceId && item.target === targetId && item.type === 'RELATED');
            if (existingIndex >= 0) {
                graph.links.splice(existingIndex, 1);
                graph.updatedAt = new Date().toISOString();
                saveMemoryGraph(graph);
                memoryGraphLinkSourceId = '';
                renderMemoryPanel();
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
            renderMemoryPanel();
        })
        .on('click', '.ai-wbr-memory-editor-delete', function () {
            const graph = getMemoryGraph();
            const id = memoryGraphSelectedNodeId;
            if (!id) {
                return;
            }
            graph.nodes = graph.nodes.filter(node => node.id !== id);
            graph.links = graph.links.filter(link => link.source !== id && link.target !== id);
            if (memoryGraphLinkSourceId === id) {
                memoryGraphLinkSourceId = '';
            }
            memoryGraphSelectedNodeId = '';
            saveMemoryGraph(graph);
        })
        .on('click', '.ai-wbr-memory-delete-node', function () {
            const graph = getMemoryGraph();
            const id = String($(this).closest('[data-memory-node-id]').data('memoryNodeId'));
            graph.nodes = graph.nodes.filter(node => node.id !== id);
            graph.links = graph.links.filter(link => link.source !== id && link.target !== id);
            if (memoryGraphSelectedNodeId === id) {
                memoryGraphSelectedNodeId = '';
            }
            if (memoryGraphLinkSourceId === id) {
                memoryGraphLinkSourceId = '';
            }
            saveMemoryGraph(graph);
        })
        .on('click', '.ai-wbr-memory-delete-link', function () {
            const graph = getMemoryGraph();
            const id = String($(this).closest('[data-memory-link-id]').data('memoryLinkId'));
            graph.links = graph.links.filter(link => String(link.id) !== id);
            if (memoryGraphSelectedLinkId === id) {
                memoryGraphSelectedLinkId = '';
            }
            saveMemoryGraph(graph);
        });
}

function debugLog(...args) {
    if (settings.debug) {
        console.debug(LOG_PREFIX, ...args);
    }
}

function debugRun(candidates, selected, injection, source, routerPrompt = '', routerRaw = '', memoryCandidates = [], selectedMemories = [], bookshelfCandidates = [], selectedBookshelf = [], pipeline = null) {
    lastRun = {
        candidates,
        selected,
        memoryCandidates,
        selectedMemories,
        bookshelfCandidates,
        selectedBookshelf,
        injectedChars: injection.length,
        injectionText: injection,
        source,
        error: '',
        routerPrompt,
        routerRaw,
        pipeline,
    };

    if (settings.debug) {
        console.groupCollapsed(`${LOG_PREFIX} routed wb ${selected.length}/${candidates.length}, memory ${selectedMemories.length}/${memoryCandidates.length}, bookshelf ${selectedBookshelf.length}/${bookshelfCandidates.length}`);
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
        console.debug('Memory candidates:', memoryCandidates.map(entry => ({
            id: entry.routerId,
            title: entry.comment,
            keys: entry.keys.all,
            matchedKeys: entry.matchedKeys,
            score: entry.score,
            type: entry.memoryType,
        })));
        console.debug('Selected memories:', selectedMemories.map(entry => ({
            id: entry.routerId,
            reason: entry.reason,
        })));
        console.debug('Bookshelf candidates:', bookshelfCandidates.map(entry => ({
            id: entry.id,
            book: entry.book?.title || entry.book?.fileName,
            title: entry.title,
            score: entry.score,
            semanticScore: entry.semanticScore,
            keywordScore: entry.keywordScore,
        })));
        console.debug('Selected bookshelf:', selectedBookshelf.map(entry => ({
            id: entry.id,
            book: entry.book?.title || entry.book?.fileName,
            title: entry.title,
            score: entry.score,
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
        memoryCandidates: [],
        selectedMemories: [],
        bookshelfCandidates: [],
        selectedBookshelf: [],
        injectedChars: 0,
        injectionText: '',
        source: 'error',
        error: error?.message || String(error),
        routerPrompt: '',
        routerRaw: '',
        pipeline: null,
    };
    renderDebugPanel();
}

async function routeWorldbookForMessages(context, recentMessages, routeSource = 'generate_interceptor', logMeta = {}) {
    const lastUserMessage = getLastUserMessage(recentMessages);
    debugLog('Generation intercepted', { ...logMeta, routeSource, lastUserMessage });

    const preRefresh = await preRefreshMemoryForRoute(context);
    const recallBundle = await buildUnifiedRecallBundle(context, recentMessages, { preRefresh });
    const {
        mvuSummary,
        memoryGraph,
        wbCandidates,
        memoryCandidates,
        bookshelfCandidates,
        selectedBookshelf: vectorSelectedBookshelf,
        selectedMemoryVectors,
        combinedCandidates,
    } = recallBundle;
    let selectedBookshelf = [];

    if (combinedCandidates.length === 0 && !hasMemoryState(memoryGraph) && !vectorSelectedBookshelf.length) {
        debugRun([], [], '', `none-${routeSource}`, '', '', [], [], bookshelfCandidates, [], recallBundle.pipeline);
        lastRouteCompletedAt = Date.now();
        return {
            candidates: wbCandidates,
            selected: [],
            memoryCandidates,
            selectedMemories: [],
            bookshelfCandidates,
            selectedBookshelf: [],
            injection: '',
            source: `none-${routeSource}`,
        };
    }

    let selectedWb = [];
    let selectedMem = [];
    let routerPrompt = '';
    let routerRaw = '';
    let source = `ai-${routeSource}`;
    let shouldFallback = false;

    if (combinedCandidates.length) {
        try {
            isRouterSelectionRequest = true;
            const maxSelectCount = settings.maxSelected + MAX_MEMORY_SELECTED + clampNumber(settings.bookshelfMaxChunks, defaultSettings.bookshelfMaxChunks, 1, 12);
            const aiResult = await selectWithAi(context, recentMessages, mvuSummary, combinedCandidates, maxSelectCount);
            
            for (const item of aiResult.selected) {
                if (item.sourceType === 'bookshelf' || item.source === 'bookshelf') {
                    selectedBookshelf.push(item);
                } else if (item.sourceType === 'memory-keyword' || item.sourceType === 'memory-vector' || item.source === 'memory' || item.source === 'memory-vector') {
                    selectedMem.push(item);
                } else {
                    selectedWb.push(item);
                }
            }
            
            routerPrompt = aiResult.prompt;
            routerRaw = aiResult.rawPreview;
            source = (selectedWb.length || selectedMem.length || selectedBookshelf.length) ? `ai-${routeSource}` : `empty-ai-${routeSource}`;
        } catch (error) {
            source = `keyword-ai-fallback-${routeSource}`;
            shouldFallback = true;
            console.warn(`${LOG_PREFIX} AI selection failed; falling back to keyword score.`, error);
            routerPrompt = error?.routerPrompt || '';
            routerRaw = error?.routerRaw || error?.message || String(error);
        } finally {
            isRouterSelectionRequest = false;
        }
    }

    if (shouldFallback && !selectedWb.length && !selectedMem.length && !selectedBookshelf.length) {
        selectedWb = selectWithFallback(wbCandidates);
        selectedMem = selectMemoryWithFallback(memoryCandidates);
        selectedBookshelf = vectorSelectedBookshelf;
    }
    selectedMem = mergeSelectedMemoryVectors(selectedMem, selectedMemoryVectors);

    if (!combinedCandidates.length && (selectedMem.length || hasMemoryState(memoryGraph))) {
        source = `memory-${routeSource}`;
    }
    if (selectedMemoryVectors.length) {
        source += '+memory-vector';
    }
    if (selectedBookshelf.length) {
        source += '+bookshelf';
    }

    const injection = buildInjection(selectedWb, memoryGraph, selectedMem, selectedBookshelf);
    setExtensionPrompt(PROMPT_KEY, injection, settings.position, settings.depth, false, settings.role);
    const pipeline = {
        ...recallBundle.pipeline,
        selected: {
            worldbook: selectedWb.length,
            memory: selectedMem.length,
            bookshelf: selectedBookshelf.length,
        },
        injection: {
            chars: injection.length,
            hasWorldbook: !!selectedWb.length,
            hasMemory: !!(selectedMem.length || hasMemoryState(memoryGraph)),
            hasBookshelf: !!selectedBookshelf.length,
        },
    };
    debugRun(wbCandidates, selectedWb, injection, source, routerPrompt, routerRaw, memoryCandidates, selectedMem, bookshelfCandidates, selectedBookshelf, pipeline);
    lastRouteCompletedAt = Date.now();

    return {
        candidates: wbCandidates,
        selected: selectedWb,
        memoryCandidates,
        selectedMemories: selectedMem,
        bookshelfCandidates,
        selectedBookshelf,
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

function bindBookshelfDynamicSettingsActions() {
    const selector = [
        '#ai_wbr_bookshelf_enabled',
        '#ai_wbr_bookshelf_auto_inject',
        '#ai_wbr_bookshelf_auto_memory_book',
        '#ai_wbr_bookshelf_memory_vector',
        '#ai_wbr_bookshelf_only_bound',
        '#ai_wbr_bookshelf_allow_global',
        '#ai_wbr_bookshelf_memory_vector_max',
        '#ai_wbr_bookshelf_max_chunks',
        '#ai_wbr_bookshelf_max_chars',
        '#ai_wbr_bookshelf_min_score',
        '#ai_wbr_bookshelf_api_url',
        '#ai_wbr_bookshelf_api_key',
        '#ai_wbr_bookshelf_api_model',
        '#ai_wbr_bookshelf_local_model',
        '#ai_wbr_bookshelf_embedding_mode',
    ].join(', ');

    $(document)
        .off('input.aiWbrBookshelfSettings change.aiWbrBookshelfSettings', selector)
        .on('input.aiWbrBookshelfSettings change.aiWbrBookshelfSettings', selector, function (event) {
            const id = String(this.id || '');
            if (id === 'ai_wbr_bookshelf_enabled') saveSetting('bookshelfEnabled', !!this.checked);
            else if (id === 'ai_wbr_bookshelf_auto_inject') saveSetting('bookshelfAutoInject', !!this.checked);
            else if (id === 'ai_wbr_bookshelf_auto_memory_book') {
                saveSetting('bookshelfAutoMemoryBook', !!this.checked);
                if (this.checked) scheduleBookshelfMemoryBookSync(getContext(), { force: true, silent: false, delayMs: 100 });
            }
            else if (id === 'ai_wbr_bookshelf_memory_vector') saveSetting('bookshelfMemoryVectorRecall', !!this.checked);
            else if (id === 'ai_wbr_bookshelf_only_bound') saveSetting('bookshelfOnlyBound', !!this.checked);
            else if (id === 'ai_wbr_bookshelf_allow_global') saveSetting('bookshelfAllowGlobal', !!this.checked);
            else if (id === 'ai_wbr_bookshelf_memory_vector_max') saveSetting('bookshelfMemoryVectorMaxItems', clampNumber($(this).val(), defaultSettings.bookshelfMemoryVectorMaxItems, 1, 12));
            else if (id === 'ai_wbr_bookshelf_max_chunks') saveSetting('bookshelfMaxChunks', clampNumber($(this).val(), defaultSettings.bookshelfMaxChunks, 1, 12));
            else if (id === 'ai_wbr_bookshelf_max_chars') saveSetting('bookshelfMaxChunkChars', clampNumber($(this).val(), defaultSettings.bookshelfMaxChunkChars, 120, 2000));
            else if (id === 'ai_wbr_bookshelf_min_score') saveSetting('bookshelfMinScore', clampNumber($(this).val(), defaultSettings.bookshelfMinScore, 0, 1));
            else if (id === 'ai_wbr_bookshelf_api_url') saveSetting('bookshelfApiUrl', normalizeUrl($(this).val()));
            else if (id === 'ai_wbr_bookshelf_api_key') saveSetting('bookshelfApiKey', String($(this).val() || '').trim());
            else if (id === 'ai_wbr_bookshelf_api_model') saveSetting('bookshelfApiModel', String($(this).val() || '').trim());
            else if (id === 'ai_wbr_bookshelf_local_model') saveSetting('bookshelfLocalModelId', String($(this).val() || '').trim());
            else if (id === 'ai_wbr_bookshelf_embedding_mode' && event.type === 'change') {
                saveSetting('bookshelfEmbeddingMode', String($(this).val() || 'api') === 'browser-local' ? 'browser-local' : 'api');
            }
            syncBookshelfProviderVisibility();
            renderBookshelfPanel();
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

function renderActiveWorldbookSelector(context = getContext()) {
    const container = $('#ai_wbr_active_world_items');
    if (!container.length) {
        return;
    }

    const bindings = getActiveWorldbookBindings(context);
    container.empty();

    if (!bindings.length) {
        container.append('<div class="ai-wbr-token-empty">当前聊天下暂无可识别的生效世界书</div>');
        return;
    }

    for (const binding of bindings) {
        const item = $('<label class="checkbox_label ai-wbr-world-option"></label>');
        const checkbox = $('<input type="checkbox" />')
            .prop('checked', getWorldSelectionState(binding.worldName))
            .attr('data-world-name', binding.worldName)
            .on('input', function () {
                setWorldSelectionState(binding.worldName, !!$(this).prop('checked'));
            });
        item.append(checkbox);
        item.append($('<span></span>').text(binding.worldName));
        item.append($('<small class="ai-wbr-world-source"></small>').text(binding.source));
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

function createFloatingMemoryWindow() {
    if ($('#ai_wbr_fab').length && $('#ai_wbr_floating_window').length) {
        updateFloatingButtonVisibility();
        clampFloatingFabToViewport();
        globalThis.aiWbrOpenConsole = (tabId = 'overview', options = {}) => {
            const existingWin = $('#ai_wbr_floating_window');
            if (!existingWin.length) {
                return;
            }
            existingWin.removeClass('closing').addClass('open');
            const mode = options?.mode || 'floating';
            const node = existingWin[0];
            node.hidden = false;
            node.removeAttribute('aria-hidden');
            node.dataset.aiWbrDisplayMode = mode;
            node.style.setProperty('visibility', 'visible', 'important');
            node.style.setProperty('opacity', '1', 'important');
            node.style.setProperty('pointer-events', 'auto', 'important');
            node.style.setProperty('z-index', '2147483646', 'important');
            node.style.setProperty('display', 'flex', 'important');
            node.style.setProperty('transform', 'none', 'important');
            applyWindowDisplayMode(existingWin, mode);
            renderStandaloneConsole(tabId || 'overview');
            setTimeout(() => {
                applyWindowDisplayMode(existingWin, node.dataset.aiWbrDisplayMode || mode);
                renderStandaloneConsole(tabId || getStandaloneTabId());
            }, 120);
            setTimeout(() => {
                applyWindowDisplayMode(existingWin, node.dataset.aiWbrDisplayMode || mode);
                renderStandaloneConsole(tabId || getStandaloneTabId());
            }, 340);
        };
        return;
    }

    $('#ai_wbr_fab').remove();
    $('#ai_wbr_floating_window').remove();
    $('#ai_wbr_emergency_fab').remove();

    const fab = $('<div id="ai_wbr_fab" class="ai-wbr-fab" title="打开记忆图谱"><i class="fa-solid fa-diagram-project"></i></div>');
    // 注意：局部变量命名为 win，避免遮蔽全局 window 对象（拖拽时需要用 window.innerWidth/innerHeight 取视口尺寸）
    const win = $('<div id="ai_wbr_floating_window" class="ai-wbr-floating-window">' +
        '<div class="ai-wbr-floating-header" id="ai_wbr_floating_header">' +
            '<div class="ai-wbr-floating-title"><i class="fa-solid fa-diagram-project"></i> 记忆图谱 <span id="ai_wbr_console_status" class="ai-wbr-console-status">等待生成</span></div>' +
            '<div class="ai-wbr-floating-close" id="ai_wbr_floating_close"><i class="fa-solid fa-times"></i></div>' +
        '</div>' +
        '<div class="ai-wbr-console-tabs" id="ai_wbr_console_tabs">' +
            '<button class="ai-wbr-console-tab active" type="button" data-tab="overview">总览</button>' +
            '<button class="ai-wbr-console-tab" type="button" data-tab="routes">路由</button>' +
            '<button class="ai-wbr-console-tab" type="button" data-tab="injection">注入</button>' +
            '<button class="ai-wbr-console-tab" type="button" data-tab="memory">记忆</button>' +
            '<button class="ai-wbr-console-tab" type="button" data-tab="graph">图谱</button>' +
            '<button class="ai-wbr-console-tab" type="button" data-tab="bookshelf">书架</button>' +
            '<button class="ai-wbr-console-tab" type="button" data-tab="debug">调试</button>' +
            '<button class="ai-wbr-console-tab" type="button" data-tab="settings">设置</button>' +
        '</div>' +
        '<div class="ai-wbr-floating-content ai-wbr-console-body" id="ai_wbr_console_body"></div>' +
    '</div>');

    $('body').append(fab).append(win);
    restoreStandalonePanelsToSettings();
    updateFloatingButtonVisibility();
    clampFloatingFabToViewport();

    // 切换悬浮窗显隐
    function clearForcedWindowStyles() {
        const node = win?.[0];
        if (!node) return;
        [
            'visibility',
            'opacity',
            'pointer-events',
            'z-index',
            'transform',
            'position',
            'inset',
            'left',
            'top',
            'right',
            'bottom',
            'width',
            'height',
            'max-width',
            'max-height',
            'border-radius',
            'display',
        ].forEach((property) => node.style.removeProperty(property));
    }

    function applyWindowDisplayMode(targetWin, mode = 'floating') {
        const node = targetWin?.[0];
        if (!node) return;
        const viewportWidth = Math.max(1, globalThis.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth || 1);
        const viewportHeight = Math.max(1, globalThis.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 1);
        const fullMode = mode === 'full';
        const mobile = viewportWidth <= 640 || viewportHeight <= 520;
        if (fullMode) {
            node.style.setProperty('position', 'fixed', 'important');
            node.style.setProperty('inset', '0', 'important');
            node.style.setProperty('left', '0', 'important');
            node.style.setProperty('top', '0', 'important');
            node.style.setProperty('right', 'auto', 'important');
            node.style.setProperty('bottom', 'auto', 'important');
            node.style.setProperty('width', '100vw', 'important');
            node.style.setProperty('height', '100dvh', 'important');
            node.style.setProperty('max-width', '100vw', 'important');
            node.style.setProperty('max-height', '100dvh', 'important');
            node.style.setProperty('border-radius', '0', 'important');
            return;
        }

        if (mobile) {
            const margin = 8;
            const width = Math.max(280, viewportWidth - margin * 2);
            const height = Math.max(320, Math.min(viewportHeight * 0.82, viewportHeight - margin * 2));
            const top = Math.max(margin, viewportHeight - height - margin);
            node.style.setProperty('position', 'fixed', 'important');
            node.style.setProperty('inset', 'auto', 'important');
            node.style.setProperty('left', `${margin}px`, 'important');
            node.style.setProperty('top', `${top}px`, 'important');
            node.style.setProperty('right', 'auto', 'important');
            node.style.setProperty('bottom', 'auto', 'important');
            node.style.setProperty('width', `${width}px`, 'important');
            node.style.setProperty('height', `${height}px`, 'important');
            node.style.setProperty('max-width', `calc(100vw - ${margin * 2}px)`, 'important');
            node.style.setProperty('max-height', `calc(100dvh - ${margin * 2}px)`, 'important');
            node.style.setProperty('border-radius', '14px', 'important');
            return;
        }

        const rect = node.getBoundingClientRect();
        const width = Math.min(Math.max(320, rect.width || node.offsetWidth || 720), Math.max(320, viewportWidth - 16));
        const height = Math.min(Math.max(360, rect.height || node.offsetHeight || 640), Math.max(360, viewportHeight - 16));
        const nextLeft = Math.max(8, Math.min(Number.isFinite(rect.left) ? rect.left : viewportWidth - width - 24, viewportWidth - width - 8));
        const nextTop = Math.max(8, Math.min(Number.isFinite(rect.top) ? rect.top : viewportHeight - height - 88, viewportHeight - height - 8));
        node.style.setProperty('position', 'fixed', 'important');
        node.style.setProperty('left', `${nextLeft}px`, 'important');
        node.style.setProperty('top', `${nextTop}px`, 'important');
        node.style.setProperty('right', 'auto', 'important');
        node.style.setProperty('bottom', 'auto', 'important');
        node.style.setProperty('width', `${width}px`, 'important');
        node.style.setProperty('height', `${height}px`, 'important');
        node.style.setProperty('max-width', 'calc(100vw - 16px)', 'important');
        node.style.setProperty('max-height', 'calc(100dvh - 16px)', 'important');
    }

    function clampWindowToViewport(mode = 'floating') {
        applyWindowDisplayMode(win, mode);
    }

    function forceWindowVisible(tabId = getStandaloneTabId(), options = {}) {
        const node = win?.[0];
        if (!node) return;
        const mode = options?.mode || 'floating';
        win.removeClass('closing').addClass('open');
        node.hidden = false;
        node.removeAttribute('aria-hidden');
        node.dataset.aiWbrDisplayMode = mode;
        node.style.setProperty('visibility', 'visible', 'important');
        node.style.setProperty('opacity', '1', 'important');
        node.style.setProperty('pointer-events', 'auto', 'important');
        node.style.setProperty('z-index', '2147483646', 'important');
        node.style.setProperty('display', 'flex', 'important');
        node.style.setProperty('transform', 'none', 'important');
        clampWindowToViewport(mode);
        renderStandaloneConsole(tabId || 'overview');
        // 动画结束后再渲染一次，确保记忆 SVG 取到动画终态的准确尺寸
        setTimeout(() => {
            clampWindowToViewport(node.dataset.aiWbrDisplayMode || mode);
            renderStandaloneConsole(tabId || getStandaloneTabId());
        }, 120);
        setTimeout(() => {
            clampWindowToViewport(node.dataset.aiWbrDisplayMode || mode);
            renderStandaloneConsole(tabId || getStandaloneTabId());
        }, 340);
    }

    function openWindow(tabId = getStandaloneTabId(), options = {}) {
        forceWindowVisible(tabId || 'overview', options);
    }

    function closeWindow() {
        if (memoryGraphFullscreenActive) {
            setMemoryGraphFullscreen(false, { fit: false });
        }
        win.removeClass('open').addClass('closing');
        restoreStandalonePanelsToSettings();
        const node = win?.[0];
        if (node) {
            node.style.setProperty('visibility', 'hidden', 'important');
            node.style.setProperty('opacity', '0', 'important');
            node.style.setProperty('pointer-events', 'none', 'important');
        }
        setTimeout(() => {
            win.removeClass('closing');
            clearForcedWindowStyles();
        }, 220); // 与 CSS 关闭动画时长一致
    }

    function toggleWindow(defaultTab = getStandaloneTabId()) {
        const isOpen = win.hasClass('open');
        if (isOpen) {
            closeWindow();
        } else {
            openWindow(defaultTab || 'overview');
        }
    }

    globalThis.aiWbrOpenConsole = (tabId = 'overview', options = {}) => {
        openWindow(tabId, options);
    };
    globalThis.aiWbrCloseConsole = closeWindow;

    // FAB 拖拽（区分点击与拖拽：移动超过 4px 视为拖拽，松手不触发开窗）
    let fabDragging = false;
    let fabMoved = false;
    let fabStartX = 0, fabStartY = 0, fabInitialLeft = 0, fabInitialTop = 0;
    let fabPointerId = null;
    let fabSuppressNextClick = false;
    let fabLastToggleAt = 0;
    let fabLastTouchAt = 0;

    function openFromFab(event, options = {}) {
        const now = Date.now();
        const minInterval = options.force ? 80 : 260;
        if (now - fabLastToggleAt < minInterval) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            return;
        }
        fabLastToggleAt = now;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        openWindow('graph', { mode: 'floating' });
        setTimeout(() => setMemoryGraphFullscreen(true), 90);
        setTimeout(() => {
            if (!win.hasClass('open') || getStandaloneTabId() !== 'graph') {
                openWindow('graph', { mode: 'floating' });
            }
            setMemoryGraphFullscreen(true);
        }, 80);
        setTimeout(() => {
            if (!win.hasClass('open') || !$('#ai_wbr_memory_graph').is(':visible')) {
                openWindow('graph', { mode: 'floating' });
            }
            setMemoryGraphFullscreen(true);
        }, 260);
    }

    function openFromFabTouch(event) {
        fabLastTouchAt = Date.now();
        fabMoved = false;
        fabDragging = false;
        fabPointerId = null;
        $('body').css('user-select', '');
        openFromFab(event, { force: true });
    }

    function finishFabPointer(e) {
        if (!fabDragging) {
            return;
        }
        if (fabPointerId !== null && e.pointerId !== undefined && e.pointerId !== fabPointerId) {
            return;
        }
        const wasTap = !fabMoved && e.type === 'pointerup';
        fabDragging = false;
        fabPointerId = null;
        clampFloatingFabToViewport();
        $('body').css('user-select', '');
        if (wasTap) {
            fabSuppressNextClick = true;
            openFromFab(e, { force: true });
            setTimeout(() => {
                fabSuppressNextClick = false;
            }, 360);
        }
    }

    fab.on('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return; // 仅左键
        fabDragging = true;
        fabMoved = false;
        fabPointerId = e.pointerId;
        fabStartX = e.clientX;
        fabStartY = e.clientY;
        // 把 right/bottom 定位转换为 left/top，便于拖拽
        const rect = fab[0].getBoundingClientRect();
        fabInitialLeft = rect.left;
        fabInitialTop = rect.top;
        fab.css({ right: 'auto', bottom: 'auto', left: fabInitialLeft + 'px', top: fabInitialTop + 'px' });
        fab[0].setPointerCapture?.(e.pointerId);
        $('body').css('user-select', 'none');
    });

    $(document).on('pointermove.fabDrag', (e) => {
        if (!fabDragging) return;
        const dx = e.clientX - fabStartX;
        const dy = e.clientY - fabStartY;
        if (!fabMoved && Math.hypot(dx, dy) < 4) return; // 阈值内仍视为点击
        fabMoved = true;
        const rect = fab[0].getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - rect.width);
        const maxTop = Math.max(0, window.innerHeight - rect.height);
        const newLeft = Math.max(0, Math.min(fabInitialLeft + dx, maxLeft));
        const newTop = Math.max(0, Math.min(fabInitialTop + dy, maxTop));
        fab.css({ left: newLeft + 'px', top: newTop + 'px' });
        e.preventDefault();
    });

    fab.on('pointerup pointercancel', finishFabPointer);
    $(document).on('pointerup.fabDrag pointercancel.fabDrag', finishFabPointer);

    fab.on('click', (e) => {
        if (Date.now() - fabLastTouchAt < 420) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (fabSuppressNextClick) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (fabMoved) {
            // 拖拽结束，抑制本次开窗
            fabMoved = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        openFromFab(e);
    });

    fab.on('touchend', (e) => {
        if (fabSuppressNextClick) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        openFromFabTouch(e);
    });

    fab[0]?.addEventListener('touchend', openFromFabTouch, { capture: true, passive: false });
    fab[0]?.addEventListener('click', (event) => {
        if (Date.now() - fabLastTouchAt < 420) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        openFromFab(event);
    }, true);

    $('#ai_wbr_floating_close').on('click touchend pointerup', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeWindow();
    });
    $('#ai_wbr_console_tabs').on('click', '.ai-wbr-console-tab', function () {
        renderStandaloneConsole(String($(this).data('tab') || 'overview'));
    });

    // ESC 关闭
    $(document).on('keydown', (event) => {
        if (event.key === 'Escape' && memoryGraphFullscreenActive) {
            setMemoryGraphFullscreen(false);
            return;
        }
        if (event.key === 'Escape' && win.hasClass('open')) {
            toggleWindow();
        }
    });

    // 拖拽逻辑（仅标题栏触发）
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    const header = $('#ai_wbr_floating_header');

    header.on('pointerdown', (e) => {
        if ($(e.target).closest('#ai_wbr_floating_close').length) return; // 排除关闭按钮
        if (e.button !== undefined && e.button !== 0) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        // 把 bottom/right 定位转换为 left/top，便于拖拽
        const rect = win[0].getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        win.css({
            right: 'auto',
            bottom: 'auto',
            left: initialLeft + 'px',
            top: initialTop + 'px'
        });

        win[0].style.removeProperty('inset');
        win[0].style.removeProperty('right');
        win[0].style.removeProperty('bottom');
        header[0].setPointerCapture?.(e.pointerId);
        $('body').css('user-select', 'none'); // 拖拽时禁止选中文本
        e.preventDefault();
    });

    $(document).on('pointermove.aiWbrWindowDrag', (e) => {
        if (!isDragging) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        // 限制在视口范围内（用全局 window.innerWidth/innerHeight 取视口尺寸）
        const rect = win[0].getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - rect.width);
        const maxTop = Math.max(0, window.innerHeight - rect.height);

        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        win.css({
            left: newLeft + 'px',
            top: newTop + 'px'
        });
        e.preventDefault();
    });

    $(document).on('pointerup.aiWbrWindowDrag pointercancel.aiWbrWindowDrag', () => {
        if (isDragging) {
            isDragging = false;
            $('body').css('user-select', '');
        }
    });

    $(window).off('resize.aiWbrFabSafeArea orientationchange.aiWbrFabSafeArea')
        .on('resize.aiWbrFabSafeArea orientationchange.aiWbrFabSafeArea', () => {
            setTimeout(clampFloatingFabToViewport, 80);
            setTimeout(clampFloatingFabToViewport, 360);
            if (win.hasClass('open')) {
                setTimeout(() => clampWindowToViewport(win[0]?.dataset.aiWbrDisplayMode || 'floating'), 80);
                setTimeout(() => clampWindowToViewport(win[0]?.dataset.aiWbrDisplayMode || 'floating'), 360);
            }
        });

    globalThis.visualViewport?.addEventListener?.('resize', () => {
        clampFloatingFabToViewport();
        if (win.hasClass('open')) clampWindowToViewport(win[0]?.dataset.aiWbrDisplayMode || 'floating');
    }, { passive: true });
    globalThis.visualViewport?.addEventListener?.('scroll', () => {
        clampFloatingFabToViewport();
        if (win.hasClass('open')) clampWindowToViewport(win[0]?.dataset.aiWbrDisplayMode || 'floating');
    }, { passive: true });

    renderStandaloneConsole('overview');
}

function updateFloatingButtonVisibility() {
    const visible = settings.floatingButtonEnabled !== false;
    $('#ai_wbr_emergency_fab').remove();
    $('#ai_wbr_fab').toggle(visible);
    if (visible) {
        clampFloatingFabToViewport();
    }
}

function clampFloatingFabToViewport() {
    const fab = $('#ai_wbr_fab');
    if (!fab.length || settings.floatingButtonEnabled === false || fab.css('display') === 'none') {
        return;
    }

    const node = fab[0];
    const rect = node.getBoundingClientRect();
    const width = Math.max(44, rect.width || node.offsetWidth || 52);
    const height = Math.max(44, rect.height || node.offsetHeight || 52);
    const viewportWidth = Math.max(1, globalThis.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, globalThis.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 1);
    const margin = Math.max(8, Math.min(16, Math.round(Math.min(viewportWidth, viewportHeight) * 0.025)));
    const maxLeft = Math.max(margin, viewportWidth - width - margin);
    const maxTop = Math.max(margin, viewportHeight - height - margin);
    const hasInlinePosition = node.style.left || node.style.top;
    const defaultLeft = Math.max(margin, viewportWidth - width - margin);
    const defaultTop = Math.max(margin, viewportHeight - height - Math.max(margin, Math.min(88, viewportHeight * 0.12)));
    const currentLeft = Number.isFinite(rect.left) && rect.width > 0 ? rect.left : defaultLeft;
    const currentTop = Number.isFinite(rect.top) && rect.height > 0 ? rect.top : defaultTop;
    const nextLeft = Math.max(margin, Math.min(hasInlinePosition ? currentLeft : defaultLeft, maxLeft));
    const nextTop = Math.max(margin, Math.min(hasInlinePosition ? currentTop : defaultTop, maxTop));

    fab.css({
        left: `${nextLeft}px`,
        top: `${nextTop}px`,
        right: 'auto',
        bottom: 'auto',
    });
}

async function loadSettingsHtml() {
    if (typeof AI_WBR_SETTINGS_HTML === 'string' && AI_WBR_SETTINGS_HTML.trim()) {
        return AI_WBR_SETTINGS_HTML;
    }

    const errors = [];
    try {
        const settingsUrl = new URL('./settings.html', import.meta.url);
        const response = await fetch(settingsUrl.href, { cache: 'no-cache' });
        if (response.ok) {
            const html = await response.text();
            if (html.includes('ai_worldbook_router_settings')) {
                return html;
            }
            errors.push(`settings.html 内容不完整：${settingsUrl.href}`);
        } else {
            errors.push(`settings.html 请求失败 ${response.status}：${settingsUrl.href}`);
        }
    } catch (error) {
        errors.push(`按当前脚本目录读取 settings.html 失败：${error?.message || error}`);
    }

    if (typeof renderExtensionTemplateAsync === 'function') {
        try {
            return await renderExtensionTemplateAsync('third-party/ai-worldbook-router', 'settings');
        } catch (error) {
            errors.push(`兼容旧目录模板读取失败：${error?.message || error}`);
        }
    }

    throw new Error(`世界书读取设置界面加载失败：${errors.join('；') || '未知错误'}`);
}

async function addSettingsUi() {
    const html = await loadSettingsHtml();
    $('#extensions_settings2').append(html);

    bindCheckbox('#ai_wbr_enabled', 'enabled');
    bindCheckbox('#ai_wbr_debug', 'debug');
    bindCheckbox('#ai_wbr_entry_diagnostics', 'entryDiagnostics');
    bindCheckbox('#ai_wbr_floating_button_enabled', 'floatingButtonEnabled');
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
    bindNumber('#ai_wbr_router_request_max_tokens', 'routerRequestMaxTokens', 32, 100000);
    bindNumber('#ai_wbr_memory_request_max_tokens', 'memoryRequestMaxTokens', 32, 100000);

    bindSelectNumber('#ai_wbr_position', 'position');
    bindSelectNumber('#ai_wbr_role', 'role');
    bindTitleBlocklistEditor();
    bindTextarea('#ai_wbr_system_prompt', 'systemPrompt');
    bindText('#ai_wbr_router_api_url', 'routerApiUrl', normalizeUrl);
    bindText('#ai_wbr_router_api_key', 'routerApiKey', (value) => String(value).trim());
    bindMemoryPanelActions();

    renderRouterModelOptions();
    renderActiveWorldbookSelector();
    $('#ai_wbr_router_model').val(settings.routerModel).on('change', function () {
        saveSetting('routerModel', String($(this).val() || ''));
    });
    $('#ai_wbr_fetch_models').on('click', async (event) => {
        event.preventDefault();
        await fetchRouterModels();
    });
    $('#ai_wbr_router_status').text(settings.routerStatus || '未连接');

    createFloatingMemoryWindow();

    renderDebugPanel();
    renderMemoryPanel();
}

globalThis.ai_worldbook_router_intercept = interceptGeneration;
installFetchFallbackHook();

function createEmergencyEntryNative() {
    document.getElementById('ai_wbr_emergency_fab')?.remove();
}

createEmergencyEntryNative();

async function bootAiWorldbookRouter() {
    try {
        ensureSettings();
        createFloatingMemoryWindow();
        try {
            await addSettingsUi();
        } catch (settingsError) {
            lastRun.error = `设置面板加载失败，但独立控制台已启用：${settingsError?.message || settingsError}`;
            console.error(`${LOG_PREFIX} Settings UI failed, standalone console remains available`, settingsError);
            renderStandaloneConsole('overview');
        }
        installFetchFallbackHook();
        installCompatSendHooks();
        ensureTavernHelperCompatHook();
        startCompatGenerateHookPolling();
        startChatScopedUiPolling();
        installChatScopedUiRefreshEventHooks();

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

        eventSource.on(event_types.CHAT_CHANGED, (...args) => {
            rememberChatIdentifierFromEvent(...args);
            pendingCompatSend = false;
            suppressCompatReplay = false;
            lastRun = {
                candidates: [],
                selected: [],
                memoryCandidates: [],
                selectedMemories: [],
                bookshelfCandidates: [],
                selectedBookshelf: [],
                injectedChars: 0,
                injectionText: '',
                source: 'none',
                error: '',
                routerPrompt: '',
                routerRaw: '',
            };
            setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
            renderActiveWorldbookSelector();
        });

        debugLog('Loaded');
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed during initialization`, error);
        try {
            ensureSettings();
            createEmergencyEntryNative();
            createFloatingMemoryWindow();
            lastRun.error = `初始化失败：${error?.message || error}`;
            renderStandaloneConsole('overview');
        } catch (fallbackError) {
            console.error(`${LOG_PREFIX} Failed to create fallback console`, fallbackError);
        }
    }
}

const readyRunner = globalThis.jQuery || globalThis.$;
if (typeof readyRunner === 'function') {
    readyRunner(bootAiWorldbookRouter);
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAiWorldbookRouter, { once: true });
} else {
    setTimeout(bootAiWorldbookRouter, 0);
}
