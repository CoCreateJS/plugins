/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 ********************************************************************************/

import Observer from "@cocreate/observer";
import { processOperators } from "./operators.js";

const plugins = {};
const scriptCache = new Map();
const cssMarker = typeof document !== 'undefined' ? document.querySelector('link[plugins]') : null;

/**
 * Initializes plugins on a collection of HTML elements.
 * @param {HTMLElement|HTMLElement[]|NodeList} elements 
 */
export function init(elements) {
    if (!elements) return;
    const collection = (elements instanceof HTMLElement || elements instanceof Element) 
        ? [elements] 
        : Array.from(elements);
    
    collection.forEach(el => {
        if (el) {
            processPlugin(el);
        }
    });
}

/**
 * Preloads registered script and stylesheet resources for designated plugins.
 * @param {string[]} pluginNames 
 */
async function preloadResources(pluginNames) {
    for (const name of pluginNames) {
        const pluginDef = plugins[name];
        if (pluginDef && !window[name]) {
            if (pluginDef.css) {
                pluginDef.css.forEach(href => {
                    if (!document.querySelector(`link[href="${href}"]`)) {
                        const link = document.createElement("link");
                        link.rel = "stylesheet"; 
                        link.href = href;
                        if (cssMarker) cssMarker.parentNode.insertBefore(link, cssMarker);
                        else document.head.appendChild(link);
                    }
                });
            }

            if (pluginDef.js) {
                for (const item of pluginDef.js) {
                    const src = typeof item === 'string' ? item : item.src;
                    if (!src) continue;
                    if (!scriptCache.has(src)) {
                        const existingScript = document.querySelector(`script[src*="${src}"]`);
                        if (existingScript && (existingScript.dataset.loaded === "true" || window[name])) {
                            scriptCache.set(src, Promise.resolve());
                        } else {
                            const s = document.createElement("script");
                            s.src = src;
                            scriptCache.set(src, new Promise((resolve) => {
                                s.onload = () => { s.dataset.loaded = "true"; resolve(); };
                                s.onerror = () => resolve();
                                document.head.appendChild(s);
                            }));
                        }
                    }
                    await scriptCache.get(src);
                }
            }
        }
    }
}

async function processPlugin(el) {
    const rawPluginAttr = el.attributes['plugin']?.value;
    if (!rawPluginAttr) return;

    // Symmetrical, pure context separation. $this strictly points to HTML Element.
    const context = {
        element: el,
        this: el,
        plugin: null,  // Tracks active sibling plugin instance
        data: { ...el.dataset },
        event: {},
        crud: window.CoCreate?.crud || null
    };

    try {
        const parsedConfig = JSON.parse(rawPluginAttr);
        const configs = Array.isArray(parsedConfig) ? parsedConfig : [parsedConfig];
        
        const targetPlugins = new Set();
        configs.forEach(conf => {
            Object.keys(conf).forEach(k => {
                if (!k.startsWith('$')) {
                    targetPlugins.add(k.split('.')[0]);
                }
            });
        });
        
        await preloadResources(Array.from(targetPlugins));

        // Execute each configuration block sequentially
        for (const configBlock of configs) {
            await executeConfigBlock(context, configBlock);
        }
    } catch (err) {
        console.error("[Plugin System] Failed to parse and execute JSON configuration in plugin attribute:", err, rawPluginAttr);
    }
}

/**
 * Instantiates the class constructor or initialization function for the plugin.
 */
function instantiatePlugin(ConstructorFunc, argsArray) {
    if (typeof ConstructorFunc !== 'function') return ConstructorFunc;
    
    // EXCEPTION FIX: Strictly pre-check the function signature for modern ES6 classes.
    // Standard functions (like particlesJS) have a truthy .prototype property by default but are NOT classes.
    const isEs6Class = /^\s*class\s+/.test(ConstructorFunc.toString());
    
    if (isEs6Class) {
        return new ConstructorFunc(...argsArray);
    }
    // Call standard functions natively with spread arguments
    return ConstructorFunc(...argsArray);
}

async function executeConfigBlock(context, configBlock) {
    for (const [key, value] of Object.entries(configBlock)) {
        // 1. If key is an operator, process it natively via AST engine
        if (key.startsWith("$")) {
            await processOperators(context, { [key]: value });
            continue;
        }

        // 2. Intercept standard lifecycle methods to bind them directly as functions on the Element
        if (["getValue", "setValue", "read", "write"].includes(key)) {
            context.element[key] = async function(...args) {
                const localContext = {
                    ...context,
                    event: { ...context.event, value: args[0], arguments: args }
                };
                return await processOperators(localContext, value);
            };
            continue;
        }

        const parts = key.split('.');
        const rootPluginName = parts[0];

        // 3. Resolve target from window object using dot notation
        let ConstructorFunc = window;
        for (const part of parts) {
            if (ConstructorFunc) {
                ConstructorFunc = ConstructorFunc[part];
            }
        }

        // 4. If it's a function, treat it as a constructor to initialize the plugin
        if (typeof ConstructorFunc === 'function' && !context.element[rootPluginName]) {
            let constructorArgs = [];
            if (value !== undefined) {
                const evaluatedArgs = await processOperators(context, value);
                constructorArgs = Array.isArray(evaluatedArgs) ? evaluatedArgs : [evaluatedArgs];
            }

            // Create the plugin instance and bind it directly to the element under its root name
            const instance = instantiatePlugin(ConstructorFunc, constructorArgs);
            context.element[rootPluginName] = instance;
            context.plugin = instance; // Update context.plugin reference for sibling method chaining
            continue;
        }

        // 5. Explicit Instance Method Chaining (e.g. "FullCalendar.render")
        let methodTarget = context.element[rootPluginName];
        if (methodTarget && parts.length > 1) {
            let method = methodTarget;
            let parent = methodTarget;
            for (let i = 1; i < parts.length; i++) {
                parent = method;
                if (method) method = method[parts[i]];
            }
            if (typeof method === 'function') {
                let methodArgs = [];
                if (value !== undefined) {
                    const evaluatedArgs = await processOperators(context, value);
                    methodArgs = Array.isArray(evaluatedArgs) ? evaluatedArgs : [evaluatedArgs];
                }
                await method.apply(parent, methodArgs);
                continue;
            }
        }

        // 6. Sibling Method Chaining (e.g. "render" directly on context.plugin)
        if (context.plugin && typeof context.plugin[key] === 'function') {
            let methodArgs = [];
            if (value !== undefined) {
                const evaluatedArgs = await processOperators(context, value);
                methodArgs = Array.isArray(evaluatedArgs) ? evaluatedArgs : [evaluatedArgs];
            }
            await context.plugin[key].apply(context.plugin, methodArgs);
            continue;
        }

        // 7. Fallback: Process operators or generic actions on properties
        await processOperators(context, { [key]: value });
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

    import("./CoCreate.config.js")
        .then((Config) => {
            const data = Config.plugins || Config.default?.plugins || Config.default || {};
            Object.assign(plugins, data);
        })
        .catch(() => {})
        .finally(() => init(document.querySelectorAll(selector)));
}