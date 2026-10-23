import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { astAsync } from '@cocreate/utils';

const code = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '')
    .replace('default { init, registerPlugin };', 'globalThis.pluginInit = init;');

class Element {
    constructor(config) {
        this.attributes = { plugin: { value: typeof config === 'string' ? config : JSON.stringify(config) } };
    }
}

function runtime(libraries, evaluate = astAsync) {
    const errors = [];
    const context = {
        astAsync: evaluate, Element,
        window: { ...libraries, Object },
        console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) }
    };
    vm.runInNewContext(code, context);
    return {
        async init(element) {
            await context.pluginInit(element);
            assert.deepEqual(errors, []);
        }
    };
}

test('bare plugin initialization does not attach its returned instance', async () => {
    let calls = 0;
    class ExamplePlugin {
        constructor() { calls++; }
    }
    const app = runtime({ ExamplePlugin });
    const el = new Element('ExamplePlugin');
    await app.init(el);
    await app.init(el);
    assert.equal(calls, 1);
    assert.equal(Object.hasOwn(el, 'ExamplePlugin'), false);
});

test('nested constructors and $return results do not attach automatically', async () => {
    class Widget {}
    const app = runtime({ Library: { Widget } });
    for (const config of [
        { '$Library.Widget': [] },
        { $return: { '$Library.Widget': [] } }
    ]) {
        const el = new Element(config);
        await app.init(el);
        assert.equal(Object.hasOwn(el, 'Library'), false);
    }
});

test('AST can explicitly store a returned instance on $this under a chosen key', async () => {
    class ExamplePlugin {}
    const app = runtime({ ExamplePlugin });
    const el = new Element({
        '$this.customInstance': { $ExamplePlugin: [] }
    });
    await app.init(el);
    assert.ok(el.customInstance instanceof ExamplePlugin);
    assert.equal(Object.hasOwn(el, 'ExamplePlugin'), false);
});

test('AST can store results elsewhere and call methods on explicit references', async () => {
    class ExamplePlugin {
        render() { this.rendered = true; }
    }
    const destination = {};
    const app = runtime({ ExamplePlugin, destination });
    const el = new Element({
        instance: { $ExamplePlugin: [] },
        '$instance.render': [],
        $return: { '$destination': { '$Object.assign': ['$destination', { instance: '$instance' }] } }
    });
    await app.init(el);
    assert.ok(destination.instance instanceof ExamplePlugin);
    assert.equal(destination.instance.rendered, true);
    assert.equal(Object.hasOwn(el, 'ExamplePlugin'), false);
    assert.equal(Object.hasOwn(el, 'instance'), false);
});

test('subsequent operations keep referencing a global library after a call returns a value', async () => {
    let calls = 0;
    function GlobalPlugin() { return {}; }
    GlobalPlugin.highlightAll = () => { calls++; };
    const app = runtime({ GlobalPlugin });
    const el = new Element({ '$GlobalPlugin': [], '$GlobalPlugin.highlightAll': [] });
    await app.init(el);
    assert.equal(calls, 1);
    assert.equal(Object.hasOwn(el, 'GlobalPlugin'), false);
});

test('passes the entire unchanged configuration to AST once with the host and library scope', async () => {
    const config = {
        created: { $ExamplePlugin: ['$this'] },
        '$this.instance': '$created',
        '$this.instance.render': []
    };
    class ExamplePlugin {
        constructor(host) { this.host = host; }
        render() { this.rendered = true; }
    }
    const calls = [];
    const app = runtime({ ExamplePlugin }, async options => {
        calls.push(options);
        return astAsync(options);
    });
    const el = new Element(config);
    await app.init(el);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].executeAST)), config);
    assert.equal(calls[0].sandbox.$this, el);
    assert.equal(calls[0].sandbox.$ExamplePlugin, ExamplePlugin);
    assert.equal(calls[0].node, el);
    assert.ok(el.instance instanceof ExamplePlugin);
    assert.equal(el.instance.host, el);
    assert.equal(el.instance.rendered, true);
});

test('plain keys store data rather than being rewritten into plugin calls', async () => {
    let calls = 0;
    function ExamplePlugin() { calls++; }
    const app = runtime({ ExamplePlugin });
    const el = new Element({
        ExamplePlugin: ['configuration data'],
        '$this.saved': '$ExamplePlugin'
    });
    await app.init(el);
    assert.equal(calls, 0);
    assert.equal(el.saved, ExamplePlugin);
});

test('configuration blocks execute in order without special treatment for $return', async () => {
    const order = [];
    function ExamplePlugin(value) { order.push(value); return value; }
    const app = runtime({ ExamplePlugin });
    const el = new Element([
        { '$this.first': { $ExamplePlugin: ['first'] } },
        { $return: { '$this.second': { $ExamplePlugin: ['$this.first'] } } }
    ]);
    await app.init(el);
    assert.deepEqual(order, ['first', 'first']);
    assert.equal(el.first, 'first');
    assert.equal(el.second, 'first');
    assert.equal(Object.hasOwn(el, 'ExamplePlugin'), false);
});
