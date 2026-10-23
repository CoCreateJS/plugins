# CoCreate Plugins

A declarative browser plugin loader and runtime for CoCreate. It loads registered JavaScript and CSS resources, exposes their browser globals to the CoCreate AST, initializes plugin instances on DOM elements, and connects those instances to standard element value APIs.

---

## Documentation

For interactive examples, visit the [CoCreate Plugins documentation](https://cocreate.app/docs/plugins).

## Table of Contents

- [Architectural Overview](#architectural-overview)
- [Installation](#installation)
- [Registering Plugin Resources](#registering-plugin-resources)
- [Using the `plugin` Attribute](#using-the-plugin-attribute)
- [AST Execution Model](#ast-execution-model)
- [Element Value Integration](#element-value-integration)
- [Programmatic API](#programmatic-api)
- [Resource Loading](#resource-loading)
- [Error Handling](#error-handling)
- [Security](#security)
- [Announcements](#announcements)
- [Roadmap](#roadmap)
- [How to Contribute](#how-to-contribute)
- [License](#license)

---

## Explicit instance storage

Plugin results are not automatically assigned to the host element. To retain a
returned instance, explicitly assign it using AST:

```html
<div plugin='{
    "$this.myInstance": {
        "$ExamplePlugin": ["$this", {}]
    }
}'></div>
```

Here `$this` identifies the host element and `myInstance` names the property to
write. The nested initializer executes first, then its returned value is
assigned to that property. A global plugin call that needs no retained result
can run without this assignment. Code that previously relied on automatic `element.PluginName`
storage must explicitly assign and reference the instance instead.

## Architectural Overview

`@cocreate/plugins` connects three parts of the browser runtime:

1. A plugin definition in `window.CoCreateConfig.plugins` identifies the JavaScript and CSS resources.
2. A DOM element's `plugin` attribute contains an AST configuration.
3. AST executes the configuration. Results are stored only where the configuration explicitly assigns them.

```text
CoCreateConfig.plugins
        │
        ├── load JavaScript and CSS
        │
        ▼
window.PluginName
        │
        ├── AST executes plugin configuration
        │
        ▼
result (optionally assigned through AST)
```

Plugin operations execute sequentially. Plugin names continue to refer to their global libraries; constructor results do not automatically replace those references or attach to the element.

The module observes `[plugin]` elements automatically, including elements added or updated after the initial page load.

---

## Installation

### NPM

```shell
npm install @cocreate/plugins
```

### Yarn

```shell
yarn add @cocreate/plugins
```

### CDN

```html
<script src="https://cdn.cocreate.app/plugins/latest/CoCreate-plugins.min.js"></script>
```

When using the package as a module:

```javascript
import plugins from "@cocreate/plugins";
```

---

## Registering Plugin Resources

Plugin resource definitions live under `window.CoCreateConfig.plugins`. The property name should match the global name created by the external library.

```javascript
window.CoCreateConfig = {
    plugins: {
        SimpleBar: {
            js: "https://cdn.jsdelivr.net/npm/simplebar@latest/dist/simplebar.min.js",
            css: "https://cdn.jsdelivr.net/npm/simplebar@latest/dist/simplebar.css"
        },
        FullCalendar: {
            js: "https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/index.global.min.js"
        }
    }
};
```

Both `js` and `css` accept one resource or an array of resources. A resource can be a URL string or an object:

```javascript
window.CoCreateConfig.plugins.Example = {
    js: [
        {
            src: "https://cdn.example.com/example.min.js",
            crossOrigin: "anonymous",
            integrity: "sha384-..."
        }
    ],
    css: [
        {
            href: "https://cdn.example.com/example.min.css",
            crossOrigin: "anonymous",
            integrity: "sha384-..."
        }
    ]
};
```

Plugins can also be registered at runtime:

```javascript
import { registerPlugin } from "@cocreate/plugins";

registerPlugin("SimpleBar", {
    js: "https://cdn.jsdelivr.net/npm/simplebar@latest/dist/simplebar.min.js",
    css: "https://cdn.jsdelivr.net/npm/simplebar@latest/dist/simplebar.css"
});
```

Registration describes where a library is loaded from. Initialization behavior belongs in the element's `plugin` attribute.

---

## Using the `plugin` Attribute

### Constructor or Function

Use an explicit AST call to initialize a plugin and a dotted destination to retain its result on the element.

```html
<div
    plugin='{
        "$this.SimpleBar": { "$SimpleBar": ["$this", {}] }
    }'
    style="max-height: 300px">
</div>
```

This is conceptually equivalent to:

```javascript
element.SimpleBar = new SimpleBar(element, {});
```

`$this` resolves to the element containing the `plugin` attribute.

For a global function that receives a single options object:

```html
<button
    plugin='{
        "$this.toast": {
            "$Toastify": {
                "text": "Saved successfully",
                "duration": 3000
            }
        },
        "$this.toast.showToast": []
    }'>
    Show notification
</button>
```

### Nested Constructor

Some libraries expose constructors as properties of a global namespace. A single nested member identifies the constructor to invoke:

```html
<div
    id="calendar"
    plugin='{
        "$this.FullCalendar": {
            "$FullCalendar.Calendar": [
                "$this",
                { "initialView": "dayGridMonth", "editable": true }
            ]
        },
        "$this.FullCalendar.render": []
    }'>
</div>
```

The first key explicitly creates and stores the instance:

```javascript
element.FullCalendar = new window.FullCalendar.Calendar(element, options);
```

The next key operates on that resolved instance:

```javascript
element.FullCalendar.render();
```

### Bare Plugin Name

A plain attribute value invokes the registered global without arguments:

```html
<div plugin="ExamplePlugin"></div>
```

Use the JSON form whenever the plugin requires the element, options, or additional operations.

### Multiple Configuration Blocks

The attribute can contain an array. Each object is processed in order:

```html
<div
    plugin='[
        { "$FirstPlugin": ["$this"] },
        { "$SecondPlugin": ["$this", {}] }
    ]'>
</div>
```

---

## AST Execution Model

Each JSON configuration object is passed unchanged to `astAsync`, once, with
the registered libraries and `$this` in its sandbox and the host element as
`node`. The plugin loader does not wrap individual entries or rewrite ordinary
keys into calls. Sibling entries share AST's evaluation scope, including values
created by earlier entries. Configuration arrays execute one block at a time.
The bare-name shorthand is expanded to `{ "$PluginName": [] }`.

```json
{
    "instance": { "$FullCalendar.Calendar": ["$this", {}] },
    "$this.calendar": "$instance",
    "$instance.render": []
}
```

JSON configs that previously relied on implicit plugin calls must use explicit
`$PluginName` or `$PluginName.method` keys. Ordinary keys declare AST data.

Execution follows these rules:

- Plugin globals are placed in the AST sandbox.
- `$this` is the element being initialized.
- Arrays are passed as positional arguments.
- An object is passed as a single argument.
- Native classes are instantiated with `new`.
- Functions are called normally.
- A resolved top-level value becomes available to subsequent keys.
- No result is automatically attached to the element, including `$return` results.
- Use an explicit AST assignment to retain an instance on `$this` or another destination.

Ordinary non-plugin keys remain part of the AST program, so they can store intermediate results or participate in later operations.

```html
<div
    plugin='{
        "instance": { "$ExamplePlugin": ["$this"] },
        "items": { "$instance.getItems": [] },
        "count": "$items.length"
    }'>
</div>
```

Top-level result keys do not automatically become element properties. Use an explicit assignment to store values on the element.

---

## Element Value Integration

The reserved `getValue` and `setValue` keys connect a plugin instance to CoCreate's standard element value interface. Unlike initialization operations, these AST expressions are stored and evaluated only when the corresponding element method is called.

```html
<div
    id="calendar"
    component
    plugin='{
        "FullCalendar": {
            "Calendar": ["$this", { "events": [] }]
        },
        "FullCalendar.render": [],
        "getValue": "$FullCalendar.getEvents",
        "setValue": {
            "$FullCalendar.addEvent": "$event.value"
        }
    }'>
</div>
```

### Reading a Value

```javascript
const events = document.querySelector("#calendar").getValue();
```

The string method reference is invoked with no arguments. Asynchronous consumers can use:

```javascript
const events = await document.querySelector("#calendar").getValueAsync();
```

### Setting a Value

```javascript
document.querySelector("#calendar").setValue({
    title: "Planning meeting",
    start: "2026-09-01"
});
```

The runtime scope exposes:

| AST value | Description |
| --- | --- |
| `$event.value` | Value passed to `element.setValue(value)` |
| `$event.dispatch` | Optional dispatch argument passed to `setValue` |
| `$this` | Element containing the plugin instance |
| `$PluginName` | Resolved plugin instance |

---

## Programmatic API

### `registerPlugin(name, config)`

Registers or replaces a resource definition in `window.CoCreateConfig.plugins`.

```javascript
registerPlugin("ExamplePlugin", {
    js: "https://cdn.example.com/plugin.js",
    css: "https://cdn.example.com/plugin.css"
});
```

### `init(elements)`

Finds and initializes plugin configurations. It accepts an element, collection, array, or selector and returns a promise.

```javascript
import { init } from "@cocreate/plugins";

await init(document.querySelector("#calendar"));
await init(document.querySelectorAll("[plugin]"));
await init("[plugin]");
```

Calling `init()` directly is generally unnecessary because the module observes matching elements automatically. It is useful when application code needs to wait for plugin initialization to complete.

---

## Resource Loading

- JavaScript resources are cached by URL and loaded once.
- CSS resources already present in the document are not inserted again.
- Multiple resources are loaded concurrently with `Promise.allSettled()`.
- String resource definitions default to `crossOrigin="anonymous"`.
- Object definitions can override `crossOrigin` or provide `integrity`.
- After loading, the runtime waits briefly for the expected browser global.

The configured name should match the library's browser global. A capitalized fallback is supported, so a configured `simpleBar` can resolve `window.SimpleBar`, but using the exact global name is recommended.

---

## Error Handling

Resource failures are logged as warnings. Initialization fails when the expected global is still unavailable after loading:

```text
[Plugin System] Plugin 'ExamplePlugin' is not available on window.
```

Invalid JSON, AST failures, constructor errors, and method errors are reported with the original `plugin` attribute for debugging.

Because initialization is asynchronous, application code that requires a completed instance should await `init()`.

---

## Security

Plugin scripts execute with the same browser privileges as the application. Only register resources from trusted locations.

For third-party CDN resources:

- Pin versions instead of relying on floating tags such as `latest`.
- Provide Subresource Integrity metadata when available.
- Use an appropriate Content Security Policy.
- Review the library's data access and network behavior.

AST configuration controls how an already trusted plugin is initialized; it does not isolate untrusted JavaScript.

---

## Announcements

Updates are documented in the project [CHANGELOG](https://github.com/CoCreate-app/CoCreate-plugins/blob/master/CHANGELOG.md) and [releases](https://github.com/CoCreate-app/CoCreate-plugins/releases).

## Roadmap

See the open [issues](https://github.com/CoCreate-app/CoCreate-plugins/issues) and [pull requests](https://github.com/CoCreate-app/CoCreate-plugins/pulls) for current development priorities.

## How to Contribute

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/CoCreate-app/CoCreate-plugins/blob/master/CONTRIBUTING.md) before opening an issue or pull request.

## License

This software is dual-licensed under the GNU Affero General Public License version 3 (AGPLv3) and a commercial license.

- **Open-source use:** Modifications and derivative works must comply with the AGPLv3. See the [LICENSE](https://github.com/CoCreate-app/CoCreate-plugins/blob/master/LICENSE).
- **Commercial use:** A commercial license is available from [CoCreate](https://cocreate.app).
