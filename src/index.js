import Observer from '@cocreate/observer';
import { astAsync } from '@cocreate/utils';

const scriptCache = new Map();
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
 * Runs in parallel using Promise.allSettled.
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
                jsFiles.forEach(src => promises.push(loadScript(src)));
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

/**
 * Parses element 'plugin' attribute, executes AST configuration via astAsync,
 * sets core library on window, and attaches instance onto element property.
 * @param {Element} el - DOM element with plugin attribute
 */
async function processPlugin(el) {
    if (!el || !el.attributes) return;

    const pluginAttrNode = el.attributes['plugin'] || el.attributes.getNamedItem?.('plugin');
    const rawPluginAttr = pluginAttrNode?.value?.trim();
    if (!rawPluginAttr) return;

    try {
        let configs = [];

        if (rawPluginAttr.startsWith('{') || rawPluginAttr.startsWith('[')) {
            const parsedConfig = JSON.parse(rawPluginAttr);
            configs = Array.isArray(parsedConfig) ? parsedConfig : [parsedConfig];
        } else {
            configs = [{ [rawPluginAttr]: [] }];
        }

        const targetPlugins = new Set();
        configs.forEach(conf => {
            Object.keys(conf).forEach(k => {
                if (!k.startsWith('\u0024')) {
                    targetPlugins.add(k.split('.')[0]);
                }
            });
        });

        await preloadResources(Array.from(targetPlugins));

        for (const configBlock of configs) {
            for (const [pluginName, astValue] of Object.entries(configBlock)) {
                // Poll window to ensure script execution has completed
                const pluginLib = await waitForPluginOnWindow(pluginName);

                // Ensure plugin library definition is attached to window once loaded
                if (pluginLib && typeof window !== 'undefined' && !window[pluginName]) {
                    window[pluginName] = pluginLib;
                }

                // Format operator key with $ for AST engine recognition (e.g. SimpleBar -> $SimpleBar)
                const operatorName = pluginName.startsWith('\u0024') ? pluginName : `$${pluginName}`;

                // Create constructor wrapper to safely instantiate class/function
                const opWrapper = function(params) {
                    const args = Array.isArray(params) ? params : [params];
                    if (typeof pluginLib === 'function') {
                        try {
                            return new pluginLib(...args);
                        } catch (e) {
                            return pluginLib(...args);
                        }
                    }
                    return pluginLib;
                };

                // Provide operator wrapper in context for AST registry lookup
                const context = {
                    [operatorName]: opWrapper
                };

                // Execute AST with the $ operator key so astAsync invokes operatorKey logic
                const result = await astAsync({
                    node: el,
                    sandbox: context,
                    executeAST: { [operatorName]: astValue }
                });

                if (result !== undefined && !pluginName.startsWith('\u0024')) {
                    // Attach returned plugin instance directly onto element property
                    el[pluginName] = result;
                }
            }
        }
    } catch (err) {
        console.error('[Plugin System] Failed to parse and execute plugin configuration:', err, rawPluginAttr);
    }
}

/**
 * Initializes plugins on single elements, collections, or selector query matches.
 * @param {Element|NodeList|Array|string} elements - Target element(s) or DOM query selector
 */
export function init(elements) {
    if (!elements) return;

    if (typeof elements === 'string') {
        elements = document.querySelectorAll(elements);
    }

    if (elements instanceof Element) {
        processPlugin(elements);
    } else if (elements.length !== undefined || Array.isArray(elements)) {
        Array.from(elements).forEach(el => {
            if (el instanceof Element) {
                processPlugin(el);
            }
        });
    }
}

if (typeof document !== 'undefined') {
    const selector = "[plugin]";
    Observer.init({
        name: "plugin",
        types: ["addedNodes", "attributes"],
        selector: selector,
        attributeFilter: ["plugin"],
        callback: (mutation) => init(mutation.target)
    });

    init(document.querySelectorAll(selector));
}

export default { init, registerPlugin };