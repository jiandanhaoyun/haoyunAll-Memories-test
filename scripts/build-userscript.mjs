import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');

const files = [
    'manifest.json',
    'index.js',
    'router-core.js',
    'settings.html',
    'style.css',
];

const userscriptPath = path.join(distDir, 'ai-worldbook-router.user.js');
const helperPath = path.join(distDir, 'ai-worldbook-router.tavern-helper.json');

await fs.mkdir(distDir, { recursive: true });

const manifest = JSON.parse(await fs.readFile(path.join(rootDir, 'manifest.json'), 'utf8'));
const generatedAt = new Date().toISOString();

const settingsHtml = await fs.readFile(path.join(rootDir, 'settings.html'), 'utf8');
const styleCss = await fs.readFile(path.join(rootDir, 'style.css'), 'utf8');
const routerCore = await fs.readFile(path.join(rootDir, 'router-core.js'), 'utf8');

const moduleSource = [
    'const hostWindow = window;',
    'const hostDocument = document;',
    `const AI_WBR_SETTINGS_HTML = ${JSON.stringify(settingsHtml)};`,
    `const AI_WBR_STYLE_CSS = ${JSON.stringify(styleCss)};`,
    routerCore,
].join('\n');

const userscript = `// ==UserScript==
// @name         ${manifest.display_name} - Tavern Helper
// @namespace    ${manifest.homepage || 'https://github.com/jiandanhaoyun/haoyunAll-Memories'}
// @version      ${manifest.version}-userscript
// @description  ${manifest.description}
// @author       ${manifest.author || 'zmer'}
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
    'use strict';

    const AI_WBR_INSTANCE_KEY = '__AI_WORLDBOOK_ROUTER_USERSCRIPT_LOADED__';

    function getHostWindow() {
        try {
            if (window.parent && window.parent !== window && window.parent.document) {
                return window.parent;
            }
        } catch (_) {}
        return window;
    }

    const hostWindow = getHostWindow();
    const hostDocument = hostWindow.document;
    if (!hostDocument || hostWindow[AI_WBR_INSTANCE_KEY]) {
        return;
    }
    hostWindow[AI_WBR_INSTANCE_KEY] = true;

    const moduleSource = ${JSON.stringify(moduleSource)};
    const script = hostDocument.createElement('script');
    script.type = 'module';
    script.textContent = moduleSource;
    script.dataset.aiWorldbookRouterUserscript = 'true';
    hostDocument.head.appendChild(script);
})();
`;

await fs.writeFile(userscriptPath, userscript, 'utf8');

let helper = {};
try {
    helper = JSON.parse(await fs.readFile(helperPath, 'utf8'));
} catch (_) {
    helper = {
        id: manifest.id,
        uid: manifest.id,
        name: manifest.display_name,
        displayName: manifest.display_name,
        title: manifest.display_name,
        type: 'script',
        format: 'tavern-helper-script',
        enabled: true,
        createdAt: generatedAt,
        scripts: [],
        metadata: {},
    };
}

helper.id = helper.id || manifest.id;
helper.uid = helper.uid || manifest.id;
helper.name = manifest.display_name;
helper.displayName = manifest.display_name;
helper.title = manifest.display_name;
helper.version = manifest.version;
helper.author = manifest.author || helper.author || '';
helper.description = manifest.description || helper.description || '';
helper.type = helper.type || 'script';
helper.format = helper.format || 'tavern-helper-script';
helper.enabled = helper.enabled ?? true;
helper.createdAt = helper.createdAt || generatedAt;
helper.updatedAt = generatedAt;
helper.script = userscript;
helper.code = userscript;
helper.content = userscript;
helper.source = userscript;
helper.scripts = Array.isArray(helper.scripts) && helper.scripts.length
    ? helper.scripts
    : [{
        id: manifest.id,
        uid: manifest.id,
        name: manifest.display_name,
        displayName: manifest.display_name,
        type: 'script',
        language: 'javascript',
        enabled: true,
        runAt: 'document-idle',
    }];
helper.scripts[0] = {
    ...helper.scripts[0],
    id: helper.scripts[0].id || manifest.id,
    uid: helper.scripts[0].uid || manifest.id,
    name: manifest.display_name,
    displayName: manifest.display_name,
    type: helper.scripts[0].type || 'script',
    language: helper.scripts[0].language || 'javascript',
    enabled: helper.scripts[0].enabled ?? true,
    runAt: helper.scripts[0].runAt || 'document-idle',
    code: userscript,
    content: userscript,
    source: userscript,
};
helper.metadata = {
    ...(helper.metadata || {}),
    originalRepository: manifest.homepage || helper.metadata?.originalRepository || '',
    originalExtensionVersion: manifest.version,
    convertedFrom: 'ai-worldbook-router',
    extensionEntry: 'index.js',
    helperEntry: 'ai-worldbook-router.user.js',
    ui: 'floating-console',
    buildGeneratedAt: generatedAt,
};

await fs.writeFile(helperPath, `${JSON.stringify(helper, null, 2)}\n`, 'utf8');

const summary = {
    name: manifest.display_name,
    id: manifest.id,
    version: manifest.version,
    generatedAt,
    files: [],
};

for (const file of files) {
    const fullPath = path.join(rootDir, file);
    const stat = await fs.stat(fullPath);
    summary.files.push({
        file,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
    });
}

for (const file of [
    path.relative(rootDir, userscriptPath).replaceAll('\\', '/'),
    path.relative(rootDir, helperPath).replaceAll('\\', '/'),
]) {
    const stat = await fs.stat(path.join(rootDir, file));
    summary.files.push({
        file,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
    });
}

await fs.writeFile(
    path.join(distDir, 'build-manifest.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
);

console.log(`Wrote ${path.relative(rootDir, userscriptPath)}`);
console.log(`Wrote ${path.relative(rootDir, helperPath)}`);
console.log(`Wrote ${path.relative(rootDir, path.join(distDir, 'build-manifest.json'))}`);
