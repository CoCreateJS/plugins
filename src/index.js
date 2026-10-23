import Observer from '@cocreate/observer';
import { astAsync } from '@cocreate/utils';

const scriptCache = new Map();
const pendingElements = new WeakSet();
const initializedPlugins = new WeakMap();
const initializingPlugins = new WeakMap();
const cssMarker = typeof document !== 'undefined'
    ? document.head.querySelector('meta[name="viewport"]') || document.head.lastChild 
    : null;

/**
 * Retrieves the global plugin configuration object from window.CoCreateConfig.
 * @returns {Object}
 */
function getPluginsConfig() {
    if (typeof window !== 'undefined' && window.CoCreateConfig && window.CoCreateConfig.plugins) {
        return window.CoCreateConfig.plugins;
    }
    return {};
}

/**
 * Dynamically registers or updates a plugin definition in global config.
 * @param {string} name - Plugin identifier
 * @param {Object} config - Plugin configuration object (js, css, etc.)
 */
export function registerPlugin(name, config) {
    if (typeof window !== 'undefined') {
        window.CoCreateConfig = window.CoCreateConfig || {};
        window.CoCreateConfig.plugins = window.CoCreateConfig.plugins || {};
        window.CoCreateConfig.plugins[name] = config;
    }
}

/**
 * Dynamic script loader to ensure plugin scripts are loaded once.
 * Sets crossOrigin="anonymous" by default for simple string URLs.
 * @param {string|Object} item - Script URL or object with configuration
 * @returns {Promise<void>}
 */
function loadScript(item) {
    const src = typeof item === 'string' ? item : item?.src;
    if (!src) return Promise.resolve();

    if (scriptCache.has(src)) return scriptCache.get(src);

    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;

        // Default crossOrigin to "anonymous" unless explicitly set otherwise in an object
        const crossOrigin = typeof item === 'object' && 'crossOrigin' in item ? item.crossOrigin : 'anonymous';
        if (crossOrigin) {
            script.crossOrigin = crossOrigin;
        }

        if (typeof item === 'object' && item.integrity) {
            script.integrity = item.integrity;
        }

        script.onload = () => resolve();
        script.onerror = () => {
            scriptCache.delete(src);
            reject(new Error(`Failed to load script: ${src}`));
        };
        document.head.appendChild(script);
    });

    scriptCache.set(src, promise);
    return promise;
}

/**
 * Dynamic CSS stylesheet loader for plugins.
 * Sets crossOrigin="anonymous" by default for simple string URLs.
 * @param {string|Object} item - Stylesheet URL or object with configuration
 * @returns {Promise<void>}
 */
function loadCSS(item) {
    const href = typeof item === 'string' ? item : item?.href;
    if (!href) return Promise.resolve();

    return new Promise((resolve, reject) => {
        if (document.querySelector(`link[href="${href}"]`)) {
            return resolve();
        }
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;

        // Default crossOrigin to "anonymous" unless explicitly set otherwise in an object
        const crossOrigin = typeof item === 'object' && 'crossOrigin' in item ? item.crossOrigin : 'anonymous';
        if (crossOrigin) {
            link.crossOrigin = crossOrigin;
        }

        if (typeof item === 'object' && item.integrity) {
            link.integrity = item.integrity;
        }

        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`Failed to load stylesheet: ${href}`));

        if (cssMarker && cssMarker.parentNode) {
            cssMarker.parentNode.insertBefore(link, cssMarker);
        } else {
            document.head.appendChild(link);
        }
    });
}

/**
 * Preloads JS scripts and CSS stylesheets declared in global plugins config.
 * Loads each plugin's JavaScript resources in declared order while allowing
 * independent plugins and stylesheets to load in parallel.
 * @param {Array<string>} pluginNames - Names of target plugins to preload
 */
async function preloadResources(pluginNames) {
    const plugins = getPluginsConfig();
    const promises = [];

    for (const name of pluginNames) {
        const config = plugins[name];
        if (config) {
            if (config.css) {
                const cssFiles = Array.isArray(config.css) ? config.css : [config.css];
                cssFiles.forEach(href => promises.push(loadCSS(href)));
            }
            if (config.js) {
                const jsFiles = Array.isArray(config.js) ? config.js : [config.js];
                promises.push((async () => {
                    for (const src of jsFiles) {
                        await loadScript(src);
                    }
                })());
            }
        }
    }

    const results = await Promise.allSettled(promises);
    results.forEach(res => {
        if (res.status === 'rejected') {
            console.warn('[Plugin System]', res.reason.message || res.reason);
        }
    });
}

/**
 * Helper to poll window for plugin library constructor if not immediately present.
 * @param {string} pluginName - Target plugin identifier
 * @param {number} retries - Number of retries
 * @param {number} delay - Retry interval in ms
 * @returns {Promise<Function|Object|null>}
 */
async function waitForPluginOnWindow(pluginName, retries = 5, delay = 50) {
    for (let i = 0; i < retries; i++) {
        const lib = getPluginLibrary(pluginName);
        if (lib) return lib;
        await new Promise(res => setTimeout(res, delay));
    }
    return getPluginLibrary(pluginName);
}

/**
 * Helper to resolve and normalize plugin library constructor from window object.
 * @param {string} pluginName - The target plugin identifier
 * @returns {Function|Object|null}
 */
function getPluginLibrary(pluginName) {
    if (typeof window === 'undefined') return null;
    if (window[pluginName]) return window[pluginName];

    // Try capitalized variant (e.g. 'simpleBar' -> 'SimpleBar')
    const capitalized = pluginName.charAt(0).toUpperCase() + pluginName.slice(1);
    if (window[capitalized]) return window[capitalized];

    return null;
}

function getPluginNames(configBlock) {
    const configuredPlugins = getPluginsConfig();
    const pluginNames = new Set();

    function collect(value) {
        if (!value || typeof value !== 'object') return;

        for (const [key, childValue] of Object.entries(value)) {
            const name = key.replace(/^\$/, '').split('.')[0];
            if (configuredPlugins[name] || getPluginLibrary(name)) {
                pluginNames.add(name);
            }
            collect(childValue);
        }
    }

    collect(configBlock);

    return pluginNames;
}

/**
 * Parses element 'plugin' attribute, executes AST configuration via astAsync,
 * with result storage controlled explicitly by the AST configuration.
 * @param {Element} el - DOM element with plugin attribute
 */
function processPlugin(el) {
    if (!el || !el.attributes) return Promise.resolve();

    const pluginAttrNode = el.attributes['plugin'] || el.attributes.getNamedItem?.('plugin');
    const rawPluginAttr = pluginAttrNode?.value?.trim();
    if (!rawPluginAttr) return Promise.resolve();

    const pending = initializingPlugins.get(el);
    if (pending?.value === rawPluginAttr) return pending.promise;
    if (initializedPlugins.get(el) === rawPluginAttr) return Promise.resolve();

    const promise = initializePlugin(el, rawPluginAttr).finally(() => {
        if (initializingPlugins.get(el)?.promise === promise) initializingPlugins.delete(el);
    });
    initializingPlugins.set(el, { value: rawPluginAttr, promise });
    return promise;
}

async function initializePlugin(el, rawPluginAttr) {
    try {
        let configs = [];

        if (rawPluginAttr.startsWith('{') || rawPluginAttr.startsWith('[')) {
            const parsedConfig = JSON.parse(rawPluginAttr);
            configs = Array.isArray(parsedConfig) ? parsedConfig : [parsedConfig];
        } else {
            configs = [{ ['$' + rawPluginAttr.replace(/^\$/, '')]: [] }];
        }

        const configPlans = configs.map(configBlock => ({
            configBlock,
            pluginNames: getPluginNames(configBlock)
        }));
        const targetPlugins = new Set(
            configPlans.flatMap(({ pluginNames }) => Array.from(pluginNames))
        );

        await preloadResources(Array.from(targetPlugins));

        for (const { configBlock, pluginNames } of configPlans) {
            const libraries = {};

            for (const pluginName of pluginNames) {
                const library = await waitForPluginOnWindow(pluginName);
                if (!library) {
                    throw new Error(`Plugin '${pluginName}' is not available on window.`);
                }
                libraries['$' + pluginName] = library;
            }

            const scope = { ...libraries, $this: el };

            await astAsync({
                executeAST: configBlock,
                sandbox: scope,
                node: el
            });
        }
        initializedPlugins.set(el, rawPluginAttr);
    } catch (err) {
        initializedPlugins.delete(el);
        console.error('[Plugin System] Failed to parse and execute plugin configuration:', err, rawPluginAttr);
    }
}

/**
 * Initializes plugins on single elements, collections, or selector query matches.
 * @param {Element|NodeList|Array|string} elements - Target element(s) or DOM query selector
 */
export function init(elements) {
    if (!elements) return Promise.resolve([]);

    if (typeof elements === 'string') {
        elements = document.querySelectorAll(elements);
    }

    if (elements instanceof Element) {
        return processPlugin(elements);
    } else if (elements.length !== undefined || Array.isArray(elements)) {
        return Promise.all(
            Array.from(elements)
                .filter(el => el instanceof Element)
                .map(el => processPlugin(el))
        );
    }

    return Promise.resolve([]);
}

function scheduleInit(element) {
    if (!element || pendingElements.has(element)) return;

    pendingElements.add(element);
    requestAnimationFrame(() => {
        pendingElements.delete(element);
        if (element.isConnected) init(element);
    });
}

if (typeof document !== 'undefined') {
    const selector = "[plugin]";
    Observer.init({
        name: "plugin",
        types: ["addedNodes", "attributes"],
        selector: selector,
        attributeFilter: ["plugin"],
        callback: (mutation) => {
            scheduleInit(mutation.target);
        }
    });

    init(document.querySelectorAll(selector));
}

export default { init, registerPlugin };
