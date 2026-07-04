const BOOT_LOG_PREFIX = '[AI Worldbook Router Bootstrap]';
const BOOT_ENTRY_ID = 'ai_wbr_bootstrap_entry';
const BOOT_PANEL_ID = 'ai_wbr_bootstrap_panel';
const BOOT_MENU_ENTRY_ID = 'ai_wbr_extension_entry';
const BOOT_MENU_RETRY_LIMIT = 80;
const BOOT_OPEN_SELECTORS = [
    `#${BOOT_MENU_ENTRY_ID}`,
    '#ai_wbr_bootstrap_entry',
    '.ai-wbr-extension-entry',
    '.ai-wbr-extension-row',
    '.ai-wbr-extension-icon',
    '.ai-wbr-extension-label'
].join(',');

let bootMenuRetryTimer = null;
let lastOpenAt = 0;
let delegatesInstalled = false;
let coreLoadError = null;
let coreLoaded = false;

function getBootDiagnostics() {
    return [
        `time: ${new Date().toLocaleString()}`,
        `clickReceived: yes`,
        `coreLoaded: ${coreLoaded || Boolean(globalThis.ai_worldbook_router_intercept)}`,
        `hasOpenFn: ${typeof globalThis.aiWbrOpenConsole}`,
        `hasFullWindow: ${Boolean(document.getElementById('ai_wbr_floating_window'))}`,
        `hasFullButton: ${Boolean(document.getElementById('ai_wbr_fab'))}`,
        `hasMenuEntry: ${Boolean(document.getElementById(BOOT_MENU_ENTRY_ID))}`,
        `jQuery: ${typeof (globalThis.jQuery || globalThis.$)}`,
        `corePath: ${new URL('./router-core.js', import.meta.url).href}`,
        `coreError: ${coreLoadError?.message || coreLoadError || 'none'}`
    ].join('\n');
}

function showBootstrapPanel(message = '') {
    let panel = document.getElementById(BOOT_PANEL_ID);
    if (!panel) {
        panel = document.createElement('div');
        panel.id = BOOT_PANEL_ID;
        panel.style.cssText = [
            'position:fixed',
            'right:12px',
            'bottom:calc(132px + env(safe-area-inset-bottom, 0px))',
            'z-index:2147483647',
            'width:min(92vw,390px)',
            'max-height:62vh',
            'overflow:auto',
            'border:1px solid rgba(176,225,255,.48)',
            'border-radius:12px',
            'background:rgba(14,17,24,.985)',
            'color:#f2fbff',
            'box-shadow:0 18px 42px rgba(0,0,0,.45)',
            'padding:14px',
            'font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'
        ].join(';');
        (document.body || document.documentElement).appendChild(panel);
    }

    panel.innerHTML = '';

    const title = document.createElement('div');
    title.textContent = '世界书读取';
    title.style.cssText = 'font-weight:800;font-size:16px;margin-bottom:8px;color:#d7f5ff';
    panel.appendChild(title);

    const text = document.createElement('div');
    text.textContent = message || '入口点击已收到，正在打开完整控制台。如果完整界面没有出现，请把下面状态发给我。';
    panel.appendChild(text);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '再次打开';
    retry.style.cssText = 'padding:6px 12px;border-radius:8px;border:1px solid rgba(176,225,255,.35);background:rgba(125,212,255,.16);color:#fff;cursor:pointer';
    retry.addEventListener('click', () => openRouterConsoleFromBootstrap({ forcePanel: false }));
    actions.appendChild(retry);

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.style.cssText = 'padding:6px 12px;border-radius:8px;border:1px solid rgba(176,225,255,.35);background:rgba(255,255,255,.08);color:#fff;cursor:pointer';
    close.addEventListener('click', () => panel.remove());
    actions.appendChild(close);
    panel.appendChild(actions);

    const hint = document.createElement('pre');
    hint.textContent = getBootDiagnostics();
    hint.style.cssText = 'white-space:pre-wrap;margin:10px 0 0;padding:8px;border-radius:8px;background:rgba(255,255,255,.08);color:#d7f5ff;font-size:12px';
    panel.appendChild(hint);

    return panel;
}

function openRouterConsoleFromBootstrap(options = {}) {
    const now = Date.now();
    if (now - lastOpenAt < 120) {
        return;
    }
    lastOpenAt = now;

    const panel = showBootstrapPanel(options.message);

    if (typeof globalThis.aiWbrOpenConsole === 'function') {
        try {
            globalThis.aiWbrOpenConsole('overview');
            window.setTimeout(() => {
                if (document.getElementById('ai_wbr_floating_window')?.classList.contains('open')) {
                    panel?.remove();
                } else {
                    showBootstrapPanel('入口点击已收到，但完整控制台没有进入打开状态。请把下面状态发给我。');
                }
            }, 220);
            return;
        } catch (error) {
            coreLoadError = error;
            showBootstrapPanel(`完整控制台打开时报错：${error?.message || error}`);
            return;
        }
    }

    const fullWindow = document.getElementById('ai_wbr_floating_window');
    if (fullWindow) {
        fullWindow.classList.remove('closing');
        fullWindow.classList.add('open');
        window.setTimeout(() => {
            if (fullWindow.classList.contains('open')) {
                panel?.remove();
            }
        }, 120);
        return;
    }

    const fullButton = document.getElementById('ai_wbr_fab');
    if (fullButton) {
        fullButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        window.setTimeout(() => {
            if (document.getElementById('ai_wbr_floating_window')?.classList.contains('open')) {
                panel?.remove();
            } else {
                showBootstrapPanel('入口点击已收到，并已转发给完整按钮，但控制台仍未打开。请把下面状态发给我。');
            }
        }, 220);
        return;
    }

    showBootstrapPanel(coreLoadError
        ? `核心模块加载失败：${coreLoadError?.message || coreLoadError}`
        : '入口点击已收到，但核心控制台还没有完成初始化。请稍等几秒后点“再次打开”。');
}

function handleBootstrapOpenEvent(event) {
    const target = event.target?.closest?.(BOOT_OPEN_SELECTORS);
    if (!target) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    openRouterConsoleFromBootstrap();
}

function installBootstrapOpenDelegates() {
    if (delegatesInstalled || !document.documentElement) {
        return;
    }

    delegatesInstalled = true;
    document.addEventListener('click', handleBootstrapOpenEvent, true);
    document.addEventListener('pointerup', handleBootstrapOpenEvent, true);
    document.addEventListener('touchend', handleBootstrapOpenEvent, true);

    globalThis.aiWorldbookRouterOpen = openRouterConsoleFromBootstrap;
    globalThis.aiWorldbookRouterDiag = () => showBootstrapPanel('手动诊断已打开。');
}

function createBootstrapEntry() {
    if (document.getElementById(BOOT_ENTRY_ID) || document.getElementById('ai_wbr_fab')) {
        return;
    }

    const button = document.createElement('button');
    button.id = BOOT_ENTRY_ID;
    button.type = 'button';
    button.textContent = '世界书';
    button.title = '打开世界书读取控制台';
    button.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:calc(82px + env(safe-area-inset-bottom, 0px))',
        'z-index:2147483647',
        'min-width:58px',
        'height:42px',
        'padding:0 10px',
        'border-radius:999px',
        'border:1px solid rgba(176,225,255,.72)',
        'background:rgba(20,24,34,.96)',
        'color:#d7f5ff',
        'font-size:13px',
        'font-weight:700',
        'box-shadow:0 10px 24px rgba(0,0,0,.35),0 0 18px rgba(125,212,255,.28)',
        'backdrop-filter:blur(8px)',
        'cursor:pointer'
    ].join(';');

    button.onclick = openRouterConsoleFromBootstrap;
    button.onpointerup = openRouterConsoleFromBootstrap;
    button.addEventListener('click', openRouterConsoleFromBootstrap, true);

    (document.body || document.documentElement).appendChild(button);
}

function createExtensionMenuEntry() {
    const entry = document.createElement('div');
    entry.id = BOOT_MENU_ENTRY_ID;
    entry.className = 'extension_container interactable ai-wbr-extension-entry';
    entry.title = '世界书读取';
    entry.setAttribute('role', 'button');
    entry.setAttribute('aria-label', '世界书读取');
    entry.tabIndex = 0;

    const row = document.createElement('div');
    row.className = 'list-group-item flex-container flexGap5 interactable ai-wbr-extension-row';
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    row.title = '世界书读取';

    const icon = document.createElement('div');
    icon.className = 'fa-fw fa-solid fa-network-wired extensionsMenuExtensionButton ai-wbr-extension-icon';
    icon.setAttribute('role', 'button');
    icon.tabIndex = 0;

    const label = document.createElement('span');
    label.className = 'ai-wbr-extension-label';
    label.textContent = '世界书读取';

    row.append(icon, label);
    entry.appendChild(row);

    const handleOpen = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        openRouterConsoleFromBootstrap();
    };

    for (const node of [entry, row, icon, label]) {
        node.onclick = handleOpen;
        node.onpointerup = handleOpen;
        node.addEventListener('click', handleOpen, true);
        node.addEventListener('pointerup', handleOpen, true);
    }

    entry.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') handleOpen(event);
    });
    row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') handleOpen(event);
    });

    return entry;
}

function mountExtensionMenuEntry() {
    const host = document.getElementById('extensionsMenu') || document.getElementById('top-settings-holder');
    if (!host) {
        return false;
    }

    let entry = document.getElementById(BOOT_MENU_ENTRY_ID);
    if (!entry) {
        entry = createExtensionMenuEntry();
    }

    if (entry.parentElement !== host) {
        host.insertBefore(entry, host.firstChild);
    }

    return true;
}

function watchExtensionMenuButton() {
    const button = document.getElementById('extensionsMenuButton');
    if (!button || button.dataset.aiWbrBound === 'true') {
        return;
    }

    button.dataset.aiWbrBound = 'true';
    button.addEventListener('click', () => {
        window.setTimeout(mountExtensionMenuEntry, 0);
        window.setTimeout(mountExtensionMenuEntry, 100);
        window.setTimeout(mountExtensionMenuEntry, 300);
    }, true);
}

function startExtensionMenuMounting() {
    installBootstrapOpenDelegates();
    watchExtensionMenuButton();
    if (mountExtensionMenuEntry()) {
        return;
    }

    let attempts = 0;
    window.clearInterval(bootMenuRetryTimer);
    bootMenuRetryTimer = window.setInterval(() => {
        attempts += 1;
        watchExtensionMenuButton();
        if (mountExtensionMenuEntry() || attempts >= BOOT_MENU_RETRY_LIMIT) {
            window.clearInterval(bootMenuRetryTimer);
            bootMenuRetryTimer = null;
        }
    }, 250);
}

async function loadRouterCore() {
    installBootstrapOpenDelegates();
    createBootstrapEntry();
    startExtensionMenuMounting();

    try {
        await import('./router-core.js');
        coreLoaded = true;
        coreLoadError = null;

        const entry = document.getElementById(BOOT_ENTRY_ID);
        if (document.getElementById('ai_wbr_fab')) {
            entry?.remove();
        }

        startExtensionMenuMounting();
        console.info(`${BOOT_LOG_PREFIX} core loaded`);
    } catch (error) {
        coreLoaded = false;
        coreLoadError = error;
        console.error(`${BOOT_LOG_PREFIX} core failed to load`, error);
        showBootstrapPanel(`核心模块加载失败：${error?.message || error}`);
    }
}

installBootstrapOpenDelegates();

if (document.body) {
    loadRouterCore();
} else {
    document.addEventListener('DOMContentLoaded', loadRouterCore, { once: true });
}
