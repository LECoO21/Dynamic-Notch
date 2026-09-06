const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function display(menuBarHeight, { x = 0, y = 0, width = 1512, height = 982 } = {}) {
  return {
    bounds: { x, y, width, height },
    workArea: { x, y: y + menuBarHeight, width, height: height - menuBarHeight },
  };
}

// Exercise real IPC and app-event handlers while replacing OS boundaries. Startup
// is deliberately not run: these tests cannot open windows or read user data.
function createMainHarness(initialDisplay) {
  const handlers = new Map();
  const appEvents = new Map();
  const screenEvents = new Map();
  const timers = new Map();
  const messages = [];
  let nextTimer = 1;
  let windowDisplay = initialDisplay;
  let cursorDisplay = initialDisplay;
  let bounds = { x: 656, y: 0, width: 200, height: 38 };
  let ignoreMouse = false;
  const nativeWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => bounds,
    setBounds: (value) => { bounds = { ...value }; },
    setIgnoreMouseEvents: (value) => { ignoreMouse = value; },
    focus: () => {},
    show: () => {},
    webContents: {
      isDestroyed: () => false,
      send: (channel, value) => messages.push({ channel, value: JSON.parse(JSON.stringify(value)) }),
    },
  };
  const electron = {
    app: {
      getPath: () => '/notch-layout-test/no-user-data',
      setName: () => {},
      setPath: () => {},
      requestSingleInstanceLock: () => true,
      on: (event, handler) => appEvents.set(event, handler),
      whenReady: () => ({ then: () => {} }),
    },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => handlers.set(channel, handler),
    },
    screen: {
      getDisplayMatching: () => windowDisplay,
      getCursorScreenPoint: () => ({ x: cursorDisplay.bounds.x, y: cursorDisplay.bounds.y }),
      getDisplayNearestPoint: () => cursorDisplay,
      getPrimaryDisplay: () => initialDisplay,
      on: (event, handler) => screenEvents.set(event, handler),
    },
    globalShortcut: { isRegistered: () => false },
  };
  const context = vm.createContext({
    Buffer,
    console,
    __dirname: path.join(__dirname, '..'),
    process: { platform: 'darwin', env: {} },
    require: (id) => {
      if (id === 'electron') return electron;
      if (id === 'child_process') return { execFile: (...args) => args.at(-1)(null, '{}') };
      if (id === './main-services') return require('../main-services');
      if (['path', 'zlib', 'crypto'].includes(id)) return require(id);
      throw new Error(`Unexpected OS dependency in layout test: ${id}`);
    },
    setTimeout: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    nativeWindow,
  });
  // All remaining imports stay inert; accessing them in a tested path is an error.
  const guardedRequire = context.require;
  context.require = (id) => ['ws', 'fs', 'http', 'dns'].includes(id) ? {} : guardedRequire(id);
  vm.runInContext(mainSource, context, { filename: 'main.js' });
  vm.runInContext('mainWindow = nativeWindow; watchDisplayChanges();', context);
  return {
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    recall: (targetDisplay) => {
      cursorDisplay = targetDisplay;
      appEvents.get('second-instance')();
    },
    changeDisplay: (targetDisplay) => {
      windowDisplay = targetDisplay;
      screenEvents.get('display-metrics-changed')();
    },
    runTimers: (delay) => {
      for (const [id, timer] of timers) {
        if (timer.delay !== delay) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    get bounds() { return bounds; },
    get ignoreMouse() { return ignoreMouse; },
    messages,
  };
}

test('expanded canvas covers the menu bar from the physical screen top', async () => {
  const harness = createMainHarness(display(38));
  await harness.invoke('window:set-mode', 'expanded');
  assert.deepEqual(harness.bounds, { x: 136, y: 0, width: 1240, height: 540 });
  assert.equal(harness.invoke('window:metrics').chromeY, 0);
  assert.match(mainSource, /mainWindow\.setAlwaysOnTop\(true, 'screen-saver'\)/);
});

test('mode changes publish layout metrics for the same display as their bounds', async () => {
  const harness = createMainHarness(display(24));
  await harness.invoke('window:set-mode', 'expanded');
  assert.equal(harness.bounds.height, 540);
  assert.equal(harness.messages.at(-1)?.channel, 'window:metrics-changed');
  assert.equal(harness.messages.at(-1)?.value.chromeY, 0);
  assert.equal(harness.messages.at(-1)?.value.menuBarHeight, 24);
});

test('cross-screen recall immediately publishes the target menu bar, including zero', async () => {
  const harness = createMainHarness(display(38));
  await harness.invoke('window:set-mode', 'expanded');
  harness.messages.length = 0;
  // The OS may still report the old window display immediately after setBounds.
  harness.recall(display(24, { x: -1600, y: -1000, width: 1600, height: 1000 }));
  assert.deepEqual(harness.bounds, { x: -1420, y: -1000, width: 1240, height: 540 });
  assert.equal(harness.messages.at(-1)?.value.chromeY, 0);
  assert.equal(harness.messages.at(-1)?.value.menuBarHeight, 24);

  harness.recall(display(0, { x: 1512 }));
  assert.deepEqual(harness.bounds, { x: 1648, y: 0, width: 1240, height: 540 });
  assert.equal(harness.messages.at(-1)?.value.chromeY, 0);
});

test('display changes publish one aligned layout update', async () => {
  const harness = createMainHarness(display(38));
  await harness.invoke('window:set-mode', 'expanded');
  harness.messages.length = 0;
  harness.changeDisplay(display(24));
  harness.runTimers(100);
  assert.equal(harness.bounds.height, 540);
  assert.deepEqual(harness.messages.map(({ channel, value }) => [channel, value.menuBarHeight]), [
    ['window:metrics-changed', 24],
  ]);
});

test('narrow and short displays preserve the existing 24px canvas safety clamp', async () => {
  const harness = createMainHarness(display(24, { x: -800, y: -500, width: 800, height: 500 }));
  await harness.invoke('window:set-mode', 'expanded');
  assert.deepEqual(harness.bounds, { x: -788, y: -500, width: 776, height: 476 });
  assert.equal(harness.invoke('window:metrics').chromeY, 0);
});

test('collapsed geometry remains 200px wide with menu-bar height and the zero-height fallback', async () => {
  for (const [menuBarHeight, expectedHeight] of [[38, 38], [24, 24], [0, 38]]) {
    const harness = createMainHarness(display(menuBarHeight));
    await harness.invoke('window:set-mode', 'collapsed');
    assert.deepEqual(harness.bounds, { x: 656, y: 0, width: 200, height: expectedHeight });
    assert.equal(harness.invoke('window:metrics').menuBarHeight, menuBarHeight);
  }
});

test('reposition during collapse preserves click-through and the collapse watchdog', async () => {
  const harness = createMainHarness(display(38));
  await harness.invoke('window:set-mode', 'expanded');
  harness.invoke('window:begin-collapse');
  assert.equal(harness.ignoreMouse, true);
  harness.changeDisplay(display(24, { x: -1600, y: -1000, width: 1600, height: 1000 }));
  harness.runTimers(100);
  assert.equal(harness.ignoreMouse, true, 'screen reposition must not swallow clicks while closing');
  assert.equal(harness.bounds.height, 540);
  harness.runTimers(650);
  assert.deepEqual(harness.bounds, { x: -900, y: -1000, width: 200, height: 24 });
  assert.equal(harness.ignoreMouse, false);
});
