// ============================================================================
// AI Worldbook Router
// SillyTavern extension bootstrap. Keep this file small and dependency-free.
// ============================================================================
(function () {
    'use strict';

    const NAMESPACE = 'AIWorldbookRouter';
const VERSION = '0.5.18';
    const LOG_PREFIX = '[AI Worldbook Router Bootstrap]';
    const ENTRY_ID = 'ai_wbr_extension_entry';
    const ROW_ID = 'ai_wbr_extension_row';
    const PANEL_ID = 'ai_wbr_bootstrap_panel';
    const FALLBACK_BUTTON_ID = 'ai_wbr_bootstrap_entry';
    const CORE_SCRIPT_ID = 'ai_wbr_router_core_script';
    const MENU_RETRY_LIMIT = 160;
    const DISPLAY_NAME = '\u4e16\u754c\u4e66\u8bfb\u53d6';
    const ENTRY_DIAGNOSTICS_KEY = 'AIWBR_entryDiagnosticsEnabled';

    const EXTENSION_DIR_NAMES = [
        'haoyunAll-Memories',
        'All-Memories',
        'ai-worldbook-router',
        'ai_worldbook_router',
    ];
    const currentScript = document.currentScript || Array.from(document.scripts).find((script) => {
        const src = String(script.src || '');
        return src.endsWith('/index.js') && EXTENSION_DIR_NAMES.some((name) => src.includes('/' + name + '/'));
    });
    const baseUrl = currentScript?.src ? new URL('./', currentScript.src).href : './';
    let coreLoadError = null;
    let coreLoading = false;
    let coreLoaded = false;
    let coreReadyPromise = null;
    let mountTimer = null;
    let observer = null;
    let lastOpenAt = 0;
    let keepPanelUntil = 0;

    window[NAMESPACE] = Object.assign(window[NAMESPACE] || {}, {
        loaded: true,
        version: VERSION,
        baseUrl,
        open: openConsole,
        diag: () => showPanel('\u624b\u52a8\u8bca\u65ad\u5df2\u6253\u5f00\u3002'),
        setEntryDiagnostics: setEntryDiagnosticsEnabled,
        mount,
    });

    function isEntryDiagnosticsEnabled() {
        try {
            return localStorage.getItem(ENTRY_DIAGNOSTICS_KEY) === 'true';
        } catch (_) {
            return false;
        }
    }

    function setEntryDiagnosticsEnabled(value) {
        try {
            localStorage.setItem(ENTRY_DIAGNOSTICS_KEY, value ? 'true' : 'false');
        } catch (_) {
            // localStorage may be unavailable in some embedded webviews.
        }
    }

    function resolveModule(path) {
        const url = new URL(path, baseUrl);
        url.searchParams.set('v', VERSION);
        url.searchParams.set('t', Date.now().toString(36));
        return url.href;
    }

    function uniqueUrls(urls) {
        return Array.from(new Set(urls.filter(Boolean)));
    }

    function resolveCoreCandidates() {
        const candidates = [];
        const addCandidate = (rawBase) => {
            try {
                const url = new URL('router-core.js', rawBase);
                url.searchParams.set('v', VERSION);
                url.searchParams.set('t', Date.now().toString(36));
                candidates.push(url.href);
            } catch (_) {
                // Ignore malformed candidate paths.
            }
        };

        if (baseUrl && baseUrl !== './') {
            addCandidate(baseUrl);
        }

        for (const script of Array.from(document.scripts)) {
            const src = String(script.src || '');
            if (!src) continue;
            if (src.endsWith('/index.js') && EXTENSION_DIR_NAMES.some((name) => src.includes('/' + name + '/'))) {
                addCandidate(new URL('./', src).href);
            }
        }

        const origin = location.origin || '';
        const roots = [
            '/scripts/extensions/third-party/',
            '/scripts/extensions/',
        ];
        for (const root of roots) {
            for (const name of EXTENSION_DIR_NAMES) {
                addCandidate(origin + root + name + '/');
            }
        }

        return uniqueUrls(candidates);
    }

    function getExtensionMenuHost() {
        return document.getElementById('extensionsMenu') || document.getElementById('top-settings-holder');
    }

    function getDiagnostics() {
        return [
            'version: ' + VERSION,
            'time: ' + new Date().toLocaleString(),
            'bootstrapLoaded: yes',
            'coreLoaded: ' + (coreLoaded || Boolean(window.ai_worldbook_router_intercept)),
            'coreLoading: ' + coreLoading,
            'hasOpenFn: ' + typeof window.aiWbrOpenConsole,
            'hasFullWindow: ' + Boolean(document.getElementById('ai_wbr_floating_window')),
            'hasFullButton: ' + Boolean(document.getElementById('ai_wbr_fab')),
            'hasFallbackButton: ' + Boolean(document.getElementById(FALLBACK_BUTTON_ID)),
            'hasMenuEntry: ' + Boolean(document.getElementById(ENTRY_ID)),
            'menuHost: ' + (getExtensionMenuHost()?.id || 'none'),
            'jQuery: ' + typeof (window.jQuery || window.$),
            'baseUrl: ' + baseUrl,
            'coreCandidates: ' + resolveCoreCandidates().join(' | '),
            'coreError: ' + (coreLoadError?.message || coreLoadError || 'none'),
        ].join('\n');
    }

    function forceConsoleVisible() {
        const win = document.getElementById('ai_wbr_floating_window');
        if (!win) return false;

        win.classList.remove('closing');
        win.classList.add('open');
        win.style.setProperty('visibility', 'visible', 'important');
        win.style.setProperty('opacity', '1', 'important');
        win.style.setProperty('pointer-events', 'auto', 'important');
        win.style.setProperty('z-index', '2147483646', 'important');
        win.style.setProperty('transform', 'none', 'important');
        win.style.setProperty('display', 'flex', 'important');

        return true;
    }

    function callOpenConsole(tab = 'overview') {
        let opened = false;
        if (typeof window.aiWbrOpenConsole === 'function') {
            window.aiWbrOpenConsole(tab);
            opened = true;
        }
        if (forceConsoleVisible()) {
            opened = true;
        }
        return opened;
    }

    function openCoreConsoleRepeatedly(tab = 'overview') {
        [0, 80, 180, 360, 700].forEach((delay) => {
            window.setTimeout(() => {
                try {
                    callOpenConsole(tab);
                } catch (error) {
                    coreLoadError = error;
                }
            }, delay);
        });
    }

    function closeHostMenusBeforeOpen() {
        document.getElementById('extensionsMenu')?.classList?.remove?.('open');
        document.querySelectorAll('.drawer-content.openDrawer, .drawer-content.open, .popup, .menu, .list-group, .openDrawer, .open')
            .forEach((node) => {
                if (node.id !== 'ai_wbr_floating_window' && !node.closest?.('#ai_wbr_floating_window')) {
                    node.classList?.remove?.('openDrawer');
                    node.classList?.remove?.('open');
                    node.classList?.remove?.('active');
                    node.style?.removeProperty?.('pointer-events');
                    node.blur?.();
                }
            });
        document.activeElement?.blur?.();
    }

    function buttonStyle(primary) {
        return [
            'padding:6px 12px',
            'border-radius:8px',
            'border:1px solid rgba(176,225,255,.35)',
            'background:' + (primary ? 'rgba(125,212,255,.16)' : 'rgba(255,255,255,.08)'),
            'color:#fff',
            'cursor:pointer',
        ].join(';');
    }

    function closeDiagnosticPanel() {
        document.getElementById(PANEL_ID)?.remove();
    }

    function confirmConsoleVisible(panel, options = {}) {
        const diagnosticsEnabled = !!options.diagnosticsEnabled;
        const forcePanel = !!options.forcePanel;
        const directUserOpen = !!options.directUserOpen;
        const reportFailure = !!options.reportFailure;
        closeHostMenusBeforeOpen();
        const isVisible = forceConsoleVisible();
        if (isVisible) {
            if (!diagnosticsEnabled) {
                closeDiagnosticPanel();
                panel?.remove?.();
            }
            return true;
        }
        if (reportFailure && (diagnosticsEnabled || forcePanel || directUserOpen)) {
            showInstantClickPanel('控制台未显示', { force: true });
            showPanel('\u5165\u53e3\u70b9\u51fb\u5df2\u6536\u5230\uff0c\u4f46\u5b8c\u6574\u63a7\u5236\u53f0\u4ecd\u672a\u8fdb\u5165\u6253\u5f00\u72b6\u6001\u3002\u8bf7\u628a\u4e0b\u9762\u72b6\u6001\u53d1\u7ed9\u6211\u3002');
        }
        return false;
    }

    function appendPanelCloseButton(panel) {
        const closeTop = document.createElement('button');
        closeTop.type = 'button';
        closeTop.textContent = '×';
        closeTop.title = '关闭诊断层';
        closeTop.setAttribute('aria-label', '关闭诊断层');
        closeTop.style.cssText = [
            'position:absolute',
            'right:8px',
            'top:8px',
            'width:30px',
            'height:30px',
            'border-radius:999px',
            'border:1px solid rgba(176,225,255,.35)',
            'background:rgba(255,255,255,.1)',
            'color:#fff',
            'font-size:20px',
            'line-height:26px',
            'cursor:pointer',
            'z-index:1',
        ].join(';');
        closeTop.addEventListener('click', closeDiagnosticPanel);
        panel.appendChild(closeTop);
    }

    function showPanel(message) {
        let panel = document.getElementById(PANEL_ID);
        if (!panel) {
            panel = document.createElement('div');
            panel.id = PANEL_ID;
            panel.style.cssText = [
                'position:fixed',
                'right:12px',
                'bottom:calc(132px + env(safe-area-inset-bottom, 0px))',
                'z-index:2147483647',
                'width:min(92vw,410px)',
                'max-height:64vh',
                'overflow:auto',
                'border:1px solid rgba(176,225,255,.52)',
                'border-radius:12px',
                'background:rgba(14,17,24,.985)',
                'color:#f2fbff',
                'box-shadow:0 18px 42px rgba(0,0,0,.45)',
                'padding:14px',
                'padding-top:42px',
                'font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
                'pointer-events:auto',
            ].join(';');
            (document.body || document.documentElement).appendChild(panel);
        }

        panel.innerHTML = '';
        appendPanelCloseButton(panel);

        const title = document.createElement('div');
        title.textContent = DISPLAY_NAME;
        title.style.cssText = 'font-weight:800;font-size:16px;margin-bottom:8px;color:#d7f5ff';
        panel.appendChild(title);

        const text = document.createElement('div');
        text.textContent = message || '\u5165\u53e3\u70b9\u51fb\u5df2\u6536\u5230\uff0c\u6b63\u5728\u6253\u5f00\u5b8c\u6574\u63a7\u5236\u53f0\u3002\u5982\u679c\u5b8c\u6574\u754c\u9762\u6ca1\u6709\u51fa\u73b0\uff0c\u8bf7\u628a\u4e0b\u9762\u72b6\u6001\u53d1\u7ed9\u6211\u3002';
        panel.appendChild(text);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';

        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '\u518d\u6b21\u6253\u5f00';
        retry.style.cssText = buttonStyle(true);
        retry.addEventListener('click', () => openConsole({ forcePanel: true, source: '诊断层重试' }));
        actions.appendChild(retry);

        const reload = document.createElement('button');
        reload.type = 'button';
        reload.textContent = '\u5237\u65b0\u9875\u9762';
        reload.style.cssText = buttonStyle(false);
        reload.addEventListener('click', () => window.location.reload());
        actions.appendChild(reload);

        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '\u5173\u95ed';
        close.style.cssText = buttonStyle(false);
        close.addEventListener('click', closeDiagnosticPanel);
        actions.appendChild(close);
        panel.appendChild(actions);

        const hint = document.createElement('pre');
        hint.textContent = getDiagnostics();
        hint.style.cssText = 'white-space:pre-wrap;margin:10px 0 0;padding:8px;border-radius:8px;background:rgba(255,255,255,.08);color:#d7f5ff;font-size:12px';
        panel.appendChild(hint);

        return panel;
    }

    function showInstantClickPanel(source = '入口', options = {}) {
        const force = !!options.force;
        if (!force && !isEntryDiagnosticsEnabled()) {
            return null;
        }
        let panel = document.getElementById(PANEL_ID);
        if (!panel) {
            panel = document.createElement('div');
            panel.id = PANEL_ID;
            (document.body || document.documentElement).appendChild(panel);
        }

        panel.style.cssText = [
            'position:fixed',
            'left:50%',
            'top:50%',
            'transform:translate(-50%,-50%)',
            'z-index:2147483647',
            'width:min(92vw,420px)',
            'max-height:72vh',
            'overflow:auto',
            'border:1px solid rgba(176,225,255,.65)',
            'border-radius:14px',
            'background:rgba(12,15,22,.99)',
            'color:#f2fbff',
            'box-shadow:0 20px 48px rgba(0,0,0,.55)',
            'padding:14px',
            'padding-top:42px',
            'font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
            'pointer-events:auto',
        ].join(';');

        panel.innerHTML = [
            '<button id="ai_wbr_panel_close_top" type="button" title="关闭诊断层" aria-label="关闭诊断层" style="position:absolute;right:8px;top:8px;width:30px;height:30px;border-radius:999px;border:1px solid rgba(176,225,255,.35);background:rgba(255,255,255,.1);color:#fff;font-size:20px;line-height:26px;cursor:pointer;z-index:1">×</button>',
            '<div style="font-weight:800;font-size:16px;margin-bottom:8px;color:#d7f5ff">世界书读取</div>',
            '<div>点击已收到：' + source + '。正在加载完整控制台...</div>',
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">',
            '<button id="ai_wbr_panel_retry" type="button" style="' + buttonStyle(true) + '">再次打开</button>',
            '<button id="ai_wbr_panel_close" type="button" style="' + buttonStyle(false) + '">关闭</button>',
            '</div>',
            '<pre style="white-space:pre-wrap;margin:10px 0 0;padding:8px;border-radius:8px;background:rgba(255,255,255,.08);color:#d7f5ff;font-size:12px">' + getDiagnostics().replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char])) + '</pre>',
        ].join('');

        document.getElementById('ai_wbr_panel_retry')?.addEventListener('click', () => openConsole({ forcePanel: true, source: '诊断层重试' }));
        document.getElementById('ai_wbr_panel_close')?.addEventListener('click', closeDiagnosticPanel);
        document.getElementById('ai_wbr_panel_close_top')?.addEventListener('click', closeDiagnosticPanel);
        return panel;
    }

    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            if (HTMLScriptElement.supports && !HTMLScriptElement.supports('module')) {
                reject(new Error('当前浏览器/WebView 不支持 module 脚本，无法加载 router-core.js'));
                return;
            }
            const script = document.createElement('script');
            const timeout = window.setTimeout(() => {
                script.remove();
                reject(new Error('router-core.js load timed out: ' + src));
            }, 7000);
            script.type = 'module';
            script.src = src;
            script.dataset.aiWbrCoreCandidate = 'true';
            script.onload = () => {
                window.clearTimeout(timeout);
                resolve(src);
            };
            script.onerror = () => {
                window.clearTimeout(timeout);
                script.remove();
                reject(new Error('router-core.js load failed: ' + src));
            };
            document.head.appendChild(script);
        });
    }

    async function loadCoreFromCandidates(candidates) {
        const errors = [];
        for (const src of candidates) {
            try {
                await loadScriptOnce(src);
                return src;
            } catch (error) {
                errors.push(error?.message || String(error));
            }
        }
        throw new Error(errors.join('\n') || 'router-core.js load failed');
    }

    function loadCore() {
        if (coreLoaded || window.ai_worldbook_router_intercept) {
            coreLoaded = true;
            return Promise.resolve();
        }

        const existing = document.getElementById(CORE_SCRIPT_ID);
        if (existing) {
            if (coreReadyPromise) return coreReadyPromise;
            if (coreLoaded || window.ai_worldbook_router_intercept) {
                coreLoaded = true;
                return Promise.resolve();
            }
            existing.remove();
        }

        if (coreLoading) {
            return coreReadyPromise || new Promise((resolve) => window.setTimeout(resolve, 260));
        }

        coreLoading = true;
        coreReadyPromise = new Promise(async (resolve, reject) => {
            const script = document.createElement('script');
            script.id = CORE_SCRIPT_ID;
            script.type = 'application/json';
            script.dataset.aiWbrLoader = 'true';
            document.head.appendChild(script);

            try {
                const loadedFrom = await loadCoreFromCandidates(resolveCoreCandidates());
                coreLoaded = true;
                coreLoading = false;
                coreLoadError = null;
                console.info(LOG_PREFIX + ' core loaded', loadedFrom);
                resolve();
            } catch (error) {
                coreLoaded = false;
                coreLoading = false;
                coreLoadError = error;
                coreReadyPromise = null;
                console.error(LOG_PREFIX + ' core failed to load', coreLoadError);
                reject(coreLoadError);
            }
        });
        return coreReadyPromise;
    }

    function waitForCoreUi(timeoutMs = 2800) {
        const startedAt = Date.now();
        return new Promise((resolve) => {
            const tick = () => {
                const ready = typeof window.aiWbrOpenConsole === 'function'
                    || Boolean(document.getElementById('ai_wbr_floating_window'))
                    || Boolean(document.getElementById('ai_wbr_fab'));
                if (ready || Date.now() - startedAt >= timeoutMs) {
                    resolve(ready);
                    return;
                }
                window.setTimeout(tick, 100);
            };
            tick();
        });
    }

    async function openConsole(options = {}) {
        const now = Date.now();
        const forcePanel = !!options.forcePanel;
        const directUserOpen = !!options.source;
        const diagnosticsEnabled = isEntryDiagnosticsEnabled();
        if (now - lastOpenAt < 120 && !directUserOpen && !forcePanel) return;
        lastOpenAt = now;

        keepPanelUntil = Date.now() + ((forcePanel || diagnosticsEnabled) ? 1600 : 0);
        closeHostMenusBeforeOpen();
        const panel = (forcePanel || diagnosticsEnabled)
            ? (document.getElementById(PANEL_ID) || showInstantClickPanel(options.source || '入口', { force: forcePanel }))
            : document.getElementById(PANEL_ID);

        try {
            await loadCore();
            await waitForCoreUi();
        } catch (error) {
            coreLoadError = error;
            if (diagnosticsEnabled || forcePanel || directUserOpen) {
                showInstantClickPanel('核心模块加载失败', { force: true });
                showPanel('\u6838\u5fc3\u6a21\u5757\u52a0\u8f7d\u5931\u8d25\uff1a' + (error?.message || error));
            }
            return;
        }

        window.setTimeout(() => {
            try {
                openCoreConsoleRepeatedly('overview');
                closeHostMenusBeforeOpen();
            } catch (error) {
                coreLoadError = error;
                if (diagnosticsEnabled || forcePanel) {
                    showInstantClickPanel('控制台打开失败', { force: true });
                    showPanel('\u5b8c\u6574\u63a7\u5236\u53f0\u6253\u5f00\u65f6\u62a5\u9519\uff1a' + (error?.message || error));
                }
                return;
            }

            [260, 520, 920, 1400].forEach((delay) => {
                window.setTimeout(() => {
                    confirmConsoleVisible(panel, { diagnosticsEnabled, forcePanel, directUserOpen, reportFailure: delay === 1400 });
                }, delay);
            });
        }, 100);
    }

    function handleOpen(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        event?.stopImmediatePropagation?.();
        const openNow = () => openConsole({ source: event?.type || '入口' });
        window.setTimeout(openNow, 20);
        window.setTimeout(openNow, 90);
        window.setTimeout(openNow, 240);
    }

    function preloadCoreForEntry(event) {
        if (!isWorldbookMenuTarget(event.target)) return;
        loadCore().catch((error) => {
            coreLoadError = error;
        });
    }

    function hardOpenFromButton(event) {
        try {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            event?.stopImmediatePropagation?.();
        } catch (_) {
            // no-op
        }
        window.setTimeout(() => openConsole({ source: event?.type || '悬浮按钮' }), 20);
        window.setTimeout(() => openConsole({ source: event?.type || '悬浮按钮' }), 220);
        window.setTimeout(() => openConsole({ source: event?.type || '悬浮按钮' }), 520);
        return false;
    }

    function isWorldbookMenuTarget(target) {
        if (!target?.closest) return false;
        if (target.closest('#' + PANEL_ID + ', #ai_wbr_fab, #' + FALLBACK_BUTTON_ID + ', #ai_wbr_floating_window')) {
            return false;
        }
        if (target.closest('#' + ENTRY_ID + ', #' + ROW_ID + ', [data-ai-wbr-entry="true"]')) {
            return true;
        }

        const menuItem = target.closest('.extension_container, .list-group-item, [role="menuitem"], [role="button"], button, a');
        if (!menuItem) return false;
        if (!menuItem.closest('#extensionsMenu, #top-settings-holder, .drawer-content, .popup, .menu, .list-group')) {
            return false;
        }
        if (menuItem.id === ENTRY_ID || menuItem.id === ROW_ID || menuItem.dataset?.aiWbrEntry === 'true') {
            return true;
        }
        if (menuItem.dataset?.extensionId === 'ai_worldbook_router') {
            return true;
        }

        const text = String(menuItem.innerText || menuItem.textContent || '').replace(/\s+/g, ' ').trim();
        return text === DISPLAY_NAME || text === `打开${DISPLAY_NAME}控制台`;
    }

    function bindGlobalEntryDelegates() {
        if (window[NAMESPACE]?.entryDelegatesBound) return;
        window[NAMESPACE].entryDelegatesBound = true;

        const delegateOpen = (event) => {
            if (!isWorldbookMenuTarget(event.target)) return;
            handleOpen(event);
        };

        document.addEventListener('click', delegateOpen, true);
        document.addEventListener('touchend', delegateOpen, { capture: true, passive: false });
        document.addEventListener('pointerdown', preloadCoreForEntry, true);
        document.addEventListener('touchstart', preloadCoreForEntry, { capture: true, passive: true });
    }

    function createExtensionMenuEntry() {
        const entry = document.createElement('div');
        entry.id = ENTRY_ID;
        entry.className = 'extension_container interactable ai-wbr-extension-entry';
        entry.dataset.aiWbrEntry = 'true';
        entry.dataset.extensionId = 'ai_worldbook_router';
        entry.title = DISPLAY_NAME;
        entry.setAttribute('role', 'button');
        entry.setAttribute('aria-label', DISPLAY_NAME);
        entry.tabIndex = 0;

        const row = document.createElement('div');
        row.id = ROW_ID;
        row.className = 'list-group-item flex-container flexGap5 interactable ai-wbr-extension-row';
        row.dataset.aiWbrEntry = 'true';
        row.dataset.extensionId = 'ai_worldbook_router';
        row.setAttribute('role', 'listitem');
        row.tabIndex = 0;
        row.title = DISPLAY_NAME;

        const icon = document.createElement('div');
        icon.className = 'fa-fw fa-solid fa-network-wired extensionsMenuExtensionButton ai-wbr-extension-icon';
        icon.setAttribute('role', 'button');
        icon.tabIndex = 0;

        const label = document.createElement('span');
        label.className = 'ai-wbr-extension-label';
        label.textContent = DISPLAY_NAME;

        row.append(icon, label);
        entry.appendChild(row);

        for (const node of [entry, row, icon, label]) {
            node.addEventListener('pointerdown', handleOpen, true);
            node.addEventListener('touchstart', handleOpen, { capture: true, passive: false });
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
        const host = getExtensionMenuHost();
        if (!host) return false;

        let entry = document.getElementById(ENTRY_ID);
        if (!entry) entry = createExtensionMenuEntry();
        if (entry.parentElement !== host) host.insertBefore(entry, host.firstChild);
        return true;
    }

    function createFallbackButton() {
        document.getElementById(FALLBACK_BUTTON_ID)?.remove();
    }

    function watchExtensionMenuButton() {
        const button = document.getElementById('extensionsMenuButton');
        if (!button || button.dataset.aiWbrBound === VERSION) return;

        button.dataset.aiWbrBound = VERSION;
        button.addEventListener('click', () => {
            window.setTimeout(mountExtensionMenuEntry, 0);
            window.setTimeout(mountExtensionMenuEntry, 100);
            window.setTimeout(mountExtensionMenuEntry, 300);
        });
    }

    function startDomObserver() {
        if (observer || !document.documentElement) return;
        observer = new MutationObserver(() => {
            mountExtensionMenuEntry();
            watchExtensionMenuButton();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    function startRetryMounting() {
        let attempts = 0;
        window.clearInterval(mountTimer);
        mountTimer = window.setInterval(() => {
            attempts += 1;
            mountExtensionMenuEntry();
            watchExtensionMenuButton();
            if (attempts >= MENU_RETRY_LIMIT) {
                window.clearInterval(mountTimer);
                mountTimer = null;
            }
        }, 250);
    }

    function mount() {
        createFallbackButton();
        mountExtensionMenuEntry();
        watchExtensionMenuButton();
        bindGlobalEntryDelegates();
        startDomObserver();
        startRetryMounting();
        console.warn(LOG_PREFIX + ' v' + VERSION + ' mounted - bootstrap is executing', { baseUrl });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }
})();
