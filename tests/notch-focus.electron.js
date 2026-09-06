const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'to-do-panel-electron-test-'));
app.setPath('userData', isolatedUserData);
app.once('will-quit', () => fs.rmSync(isolatedUserData, { recursive: true, force: true }));

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 200,
    height: 38,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      // 与生产主窗口一致，避免 macOS 将重复运行的测试窗口判为遮挡后暂停 rAF。
      backgroundThrottling: false,
    },
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    const freshProfileClipboardState = await window.webContents.executeJavaScript(`
      (() => ({
        history: localStorage.getItem('notch-clip-history'),
        favorites: localStorage.getItem('notch-clip-favorites'),
        imageRows: document.querySelectorAll('#clip-list [data-type="image"]').length,
      }))()
    `);
    assert.deepEqual(freshProfileClipboardState, {
      history: null,
      favorites: null,
      imageRows: 0,
    }, '全新用户目录不得预置任何剪贴板文本、收藏或图片记录');

    await window.webContents.executeJavaScript(`
      localStorage.setItem(
        'notch-home-order-v3',
        JSON.stringify(['commands', 'mirror', 'note', 'windows', 'recorder', 'pomodoro', 'music'])
      )
    `);
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    const migratedHomeOrder = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('#home-bento [data-home-module]')]
        .sort((left, right) => Number(left.style.order) - Number(right.style.order))
        .map((tile) => tile.dataset.homeModule)
    `);
    assert.deepEqual(
      migratedHomeOrder,
      ['commands', 'note', 'windows', 'recorder', 'pomodoro', 'music'],
      '旧首页顺序含已移除的镜子时，必须保留其余六个模块的用户排序'
    );
    await window.webContents.executeJavaScript(`localStorage.removeItem('notch-home-order-v3')`);
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    await window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    window.show();
    window.focus();
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    const focusStyle = await window.webContents.executeJavaScript(`
      (async () => {
        const notch = document.getElementById('notch');
        const deadline = performance.now() + 5000;
        let result;
        do {
          const notchStyle = getComputedStyle(notch);
          const dotStyle = getComputedStyle(notch.querySelector('.notch-dot'));
          result = {
            active: document.activeElement === notch,
            focusVisible: notch.matches(':focus-visible'),
            outlineStyle: notchStyle.outlineStyle,
            outlineWidth: notchStyle.outlineWidth,
            dotBoxShadow: dotStyle.boxShadow,
          };
          if (result.active && result.focusVisible) return result;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (performance.now() < deadline);
        return result;
      })()
    `);

    assert.equal(focusStyle.active, true, '折叠条应能通过键盘获得焦点');
    assert.equal(focusStyle.focusVisible, true, '键盘焦点应保持可见提示');
    assert.equal(
      focusStyle.outlineStyle,
      'none',
      `折叠外壳不能画焦点描边，当前为 ${focusStyle.outlineWidth} ${focusStyle.outlineStyle}`
    );
    assert.notEqual(focusStyle.dotBoxShadow, 'none', '焦点提示应转移到中间抓握条');

    const collapsedPanelLayers = await window.webContents.executeJavaScript(`
      (() => {
        const panel = document.querySelector('.panel');
        return {
          contentClipPath: getComputedStyle(panel).clipPath,
          shellDisplay: getComputedStyle(panel, '::before').display,
          shellOpacity: getComputedStyle(panel, '::before').opacity,
          notchBackground: getComputedStyle(document.getElementById('notch')).backgroundColor,
        };
      })()
    `);
    assert.equal(
      collapsedPanelLayers.contentClipPath,
      'none',
      '折叠动效不得裁剪承载全部组件的内容层'
    );
    assert.equal(
      collapsedPanelLayers.shellDisplay,
      'block',
      '轻量形变底板应保留为展开/收起动画载体'
    );
    assert.equal(collapsedPanelLayers.shellOpacity, '0', '折叠态形变底板必须完全不可见，只保留独立刘海');
    assert.equal(collapsedPanelLayers.notchBackground, 'rgb(0, 0, 0)');

    window.setSize(1240, 616);
    const topbarBlankToggle = await window.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitForClass = async (name) => {
          const deadline = performance.now() + 5000;
          while (performance.now() < deadline) {
            if (document.getElementById('app').classList.contains(name)) return true;
            await sleep(10);
          }
          return false;
        };
        // 生产默认开启超过四个 Tab，会进入左右分栏并让容器横跨整条顶栏。
        document.getElementById('tabs').classList.add('is-split');
        document.getElementById('notch').click();
        const opened = await waitForClass('expanded');
        const topbar = document.getElementById('tabs').getBoundingClientRect();
        const x = topbar.left + topbar.width / 2;
        const y = topbar.top + topbar.height / 2;
        const hitTarget = document.elementFromPoint(x, y);
        const interceptedByTabs = Boolean(hitTarget?.closest('.tabs'));
        hitTarget?.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }));
        const collapsed = await waitForClass('collapsed');
        return {
          opened,
          collapsed,
          interceptedByTabs,
          hitTarget: hitTarget?.id || hitTarget?.className || hitTarget?.tagName || '',
          appClass: document.getElementById('app').className,
          panelAriaHidden: document.querySelector('.panel').getAttribute('aria-hidden'),
        };
      })()
    `);
    assert.equal(topbarBlankToggle.opened, true, '折叠岛点击后必须展开');
    assert.equal(
      topbarBlankToggle.interceptedByTabs,
      false,
      `顶部中央空白不得被 Tab 容器截获，当前命中 ${topbarBlankToggle.hitTarget}`
    );
    assert.equal(
      topbarBlankToggle.collapsed,
      true,
      `展开后点击顶部中央空白必须收起；最终状态 ${topbarBlankToggle.appClass} / aria-hidden=${topbarBlankToggle.panelAriaHidden}`
    );

    const topbarTabAndSpaceToggle = await window.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitForClass = async (name) => {
          const deadline = performance.now() + 5000;
          while (performance.now() < deadline) {
            if (document.getElementById('app').classList.contains(name)) return true;
            await sleep(10);
          }
          return false;
        };
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }));
        const opened = await waitForClass('expanded');
        const todoButton = document.getElementById('tab-button-todo');
        const rect = todoButton.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        hitTarget?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(30);
        const todoActivated = document.getElementById('tab-todo').classList.contains('active');
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }));
        const collapsedBySpace = await waitForClass('collapsed');
        return {
          opened,
          todoActivated,
          tabHit: Boolean(hitTarget?.closest('#tab-button-todo')),
          collapsedBySpace,
        };
      })()
    `);
    assert.equal(topbarTabAndSpaceToggle.opened, true);
    assert.equal(topbarTabAndSpaceToggle.tabHit, true, '空白穿透不得破坏真实 Tab 的点击命中');
    assert.equal(topbarTabAndSpaceToggle.todoActivated, true, '真实 Tab 点击必须继续切换页面');
    assert.equal(topbarTabAndSpaceToggle.collapsedBySpace, true, '展开后 Space 必须继续收起');

    window.setSize(1240, 616);
    const settingsSurface = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const appSurface = document.getElementById('app');
        appSurface.classList.remove('collapsed');
        appSurface.classList.add('expanded');
        document.getElementById('tab-button-settings').click();
        setTimeout(() => {
          const page = document.getElementById('settings-page');
          const panel = document.querySelector('.panel');
          const shellStyle = getComputedStyle(panel, '::before');
          const boardStyle = getComputedStyle(document.getElementById('panels'));
          const nav = document.getElementById('tabs');
          const navStyle = getComputedStyle(nav);
          const primary = nav.querySelector('.tabs-group-primary').getBoundingClientRect();
          const utilities = nav.querySelector('.tabs-group-utilities').getBoundingClientRect();
          const rightmostTab = [...nav.querySelectorAll('.tab[data-tab]:not([hidden])')]
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
          resolve({
            contentClipPath: getComputedStyle(panel).clipPath,
            morphSurfaceBackground: shellStyle.backgroundColor,
            morphSurfaceInsets: [shellStyle.top, shellStyle.right, shellStyle.bottom, shellStyle.left],
            outerPanelTransparent: getComputedStyle(panel).backgroundColor === 'rgba(0, 0, 0, 0)',
            boardBackground: boardStyle.backgroundColor,
            boardCornerRadii: [
              boardStyle.borderTopLeftRadius,
              boardStyle.borderTopRightRadius,
              boardStyle.borderBottomRightRadius,
              boardStyle.borderBottomLeftRadius,
            ],
            rightmostTab: rightmostTab?.dataset.tab,
            separateNavBases: primary.right < utilities.left,
            navGapIsClear: navStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
              && navStyle.backgroundImage === 'none' && navStyle.boxShadow === 'none'
              && navStyle.backdropFilter === 'none',
            indicatorInUtilities: document.getElementById('tab-indicator').parentElement
              === nav.querySelector('.tabs-group-utilities'),
            activePanel: document.getElementById('tab-settings')?.classList.contains('active'),
            display: getComputedStyle(page).display,
            columns: getComputedStyle(page).gridTemplateColumns.split(' ').filter(Boolean).length,
            api: Boolean(document.getElementById('settings-api-configure')),
            features: document.querySelectorAll('[data-settings-feature]').length,
            homeModules: document.querySelectorAll('[data-settings-home-module]').length,
            shortcut: Boolean(document.getElementById('settings-shortcut-change')),
            workspace: Boolean(document.getElementById('settings-workspace-choose')),
            autoLaunch: Boolean(document.getElementById('settings-auto-launch')),
          });
        }, 80);
      })
    `);

    assert.deepEqual(settingsSurface, {
      contentClipPath: 'none',
      morphSurfaceBackground: 'rgb(251, 249, 250)',
      morphSurfaceInsets: ['0px', '8px', '8px', '8px'],
      outerPanelTransparent: true,
      boardBackground: 'rgba(0, 0, 0, 0)',
      boardCornerRadii: ['0px', '0px', '28px', '28px'],
      rightmostTab: 'settings',
      separateNavBases: true,
      navGapIsClear: true,
      indicatorInUtilities: true,
      activePanel: true,
      display: 'grid',
      columns: 2,
      api: true,
      features: 6,
      homeModules: 6,
      shortcut: true,
      workspace: true,
      autoLaunch: true,
    });

    // Replay menu-bar changes in one renderer, including auto-hide (0px) and return.
    for (const menuBarHeight of [38, 24, 0, 38]) {
      window.setSize(1240, 540);
      const alignment = await window.webContents.executeJavaScript(`
        (async () => {
          applyLayoutMetrics({ menuBarHeight: ${menuBarHeight}, stripHeight: ${menuBarHeight || 38} });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const board = document.getElementById('panels').getBoundingClientRect();
          const topbar = document.querySelector('.topbar').getBoundingClientRect();
          const tabs = document.getElementById('tabs').getBoundingClientRect();
          return { boardTop: board.top, boardHeight: board.height, topbarHeight: topbar.height,
            navInsideBoard: tabs.top >= board.top && tabs.bottom <= board.bottom };
        })()
      `);
      assert.equal(alignment.boardTop, 0, '白色底板必须从屏幕最上沿开始并覆盖菜单栏');
      assert.equal(alignment.topbarHeight, 0, '展开时不再为菜单栏保留透明占位');
      assert.equal(alignment.boardHeight, 532, '调整顶部留白时必须保留底板和卡片尺寸');
      assert.equal(alignment.navInsideBoard, true);
    }

    const hoverModules = ['music', 'pomodoro', 'recorder', 'windows', 'note', 'commands'];
    await window.webContents.executeJavaScript(`
      syncPanelAccessibility(true);
      document.getElementById('tab-button-home').click();
      document.activeElement?.blur();
      void 0;
    `);
    const readSizeControls = () => window.webContents.executeJavaScript(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 180));
      return [...document.querySelectorAll('#home-bento [data-widget-size-cycle]')].map(button => ({
        id: button.dataset.widgetSizeCycle,
        opacity: getComputedStyle(button).opacity,
        pointerEvents: getComputedStyle(button).pointerEvents,
      }));
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 620, y: 1 });
    // Force CSS states so native cursor movement/window occlusion cannot race this audit.
    await window.webContents.debugger.sendCommand('DOM.enable');
    await window.webContents.debugger.sendCommand('CSS.enable');
    const { root: hoverRoot } = await window.webContents.debugger.sendCommand('DOM.getDocument');
    const hoverNodes = new Map();
    for (const moduleId of hoverModules) {
      const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: hoverRoot.nodeId, selector: `#home-bento [data-home-module="${moduleId}"]`,
      });
      assert.ok(nodeId, `${moduleId} 卡片必须存在`);
      hoverNodes.set(moduleId, nodeId);
    }
    for (const moduleId of [null, ...hoverModules, null]) {
      for (const [id, nodeId] of hoverNodes) {
        await window.webContents.debugger.sendCommand('CSS.forcePseudoState', {
          nodeId, forcedPseudoClasses: id === moduleId ? ['hover'] : [],
        });
      }
      const controls = await readSizeControls();
      assert.equal(controls.length, 6);
      for (const control of controls) {
        assert.equal(control.opacity, control.id === moduleId ? '1' : '0', `${control.id} 尺寸按钮只在对应卡片 hover 时显示`);
        assert.equal(control.pointerEvents, control.id === moduleId ? 'auto' : 'none');
      }
    }
    const { nodeId: musicSizeControlNode } = await window.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: hoverRoot.nodeId, selector: '[data-widget-size-cycle="music"]',
    });
    await window.webContents.debugger.sendCommand('CSS.forcePseudoState', {
      nodeId: musicSizeControlNode, forcedPseudoClasses: ['focus-visible'],
    });
    assert.equal((await readSizeControls()).find(control => control.id === 'music').opacity, '1', '键盘聚焦尺寸按钮时必须可见');
    await window.webContents.debugger.sendCommand('CSS.forcePseudoState', {
      nodeId: musicSizeControlNode, forcedPseudoClasses: [],
    });
    const credentialSelectionAudit = await window.webContents.executeJavaScript(`
      (async () => {
        const originalApi = window.notchAPI;
        const item = {
          id: 'credential-selection-test',
          service: 'Example',
          account: 'me@example.com',
          password: 'secret',
          passwordMask: '**********',
        };
        window.notchAPI = {
          saveCredential: async () => ({ ok: true }),
          listCredentials: async () => ({ items: [item], secureStorage: true }),
          getCredential: async () => ({ ok: true, item }),
          deleteCredentials: async () => ({ ok: true }),
          copyCredential: async () => true,
        };
        document.getElementById('tab-button-credentials').click();
        document.getElementById('credential-service').value = item.service;
        document.getElementById('credential-account').value = item.account;
        document.getElementById('credential-password').value = item.password;
        document.getElementById('credential-save').click();
        const deadline = performance.now() + 2000;
        while (!document.querySelector('.credential-item[data-id="credential-selection-test"]')
          && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        let row = document.querySelector('.credential-item[data-id="credential-selection-test"]');
        row.querySelector('.credential-copy').dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          shiftKey: true,
        }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const bulkDelete = document.getElementById('credential-bulk-delete');
        const selected = document.querySelector('.credential-item[data-id="credential-selection-test"]');
        const searchRect = document.getElementById('credential-search').getBoundingClientRect();
        const deleteRect = bulkDelete.getBoundingClientRect();
        const selectedState = {
          card: selected.classList.contains('multi-selected'),
          deleteVisible: !bulkDelete.hidden && getComputedStyle(bulkDelete).display !== 'none',
          actionsShareOneRow: Math.abs(
            (searchRect.top + searchRect.bottom) / 2 - (deleteRect.top + deleteRect.bottom) / 2
          ) < 2 && deleteRect.left >= searchRect.right,
        };
        selected.querySelector('.credential-copy').click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        row = document.querySelector('.credential-item[data-id="credential-selection-test"]');
        const clearedState = {
          card: row.classList.contains('multi-selected'),
          deleteHidden: bulkDelete.hidden && getComputedStyle(bulkDelete).display === 'none',
          editing: row.classList.contains('editing'),
        };
        window.notchAPI = originalApi;
        return { selectedState, clearedState };
      })()
    `);
    assert.deepEqual(credentialSelectionAudit, {
      selectedState: { card: true, deleteVisible: true, actionsShareOneRow: true },
      clearedState: { card: false, deleteHidden: true, editing: false },
    }, '密钥批量删除应与搜索框同行，并在取消选中后隐藏');

    const todoCalendarNavigation = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        document.getElementById('tab-button-todo').click();
        const trigger = document.querySelector('.todo-deadline-trigger[data-deadline-priority="P0"]');
        trigger.click();
        const previous = document.getElementById('todo-calendar-previous');
        const next = document.getElementById('todo-calendar-next');
        if (!previous || !next) {
          resolve({ controls: false });
          return;
        }
        const base = new Date();
        const popover = document.getElementById('todo-date-popover');
        const previousRect = previous.getBoundingClientRect();
        const nextRect = next.getBoundingClientRect();
        const clicksToJanuary = 12 - base.getMonth();
        for (let index = 0; index < clicksToJanuary; index += 1) next.click();
        const expectedYear = base.getFullYear() + 1;
        const januaryLabel = document.getElementById('todo-editor-month').textContent.trim();
        const day = [...document.querySelectorAll('#todo-calendar-grid [data-day]')]
          .find((button) => button.dataset.day === '2');
        day.click();
        const selected = new Date(trigger.dataset.deadline);
        previous.click();
        resolve({
          controls: true,
          popoverVisible: !popover.hidden && getComputedStyle(popover).display !== 'none',
          controlsUsable: [previousRect.width, previousRect.height, nextRect.width, nextRect.height]
            .every((size) => size >= 18),
          januaryLabel,
          decemberLabel: document.getElementById('todo-editor-month').textContent.trim(),
          selected: [selected.getFullYear(), selected.getMonth(), selected.getDate()],
          expectedYear,
        });
      })
    `);

    assert.deepEqual(todoCalendarNavigation, {
      controls: true,
      popoverVisible: true,
      controlsUsable: true,
      januaryLabel: `${new Date().getFullYear() + 1}年 1月`,
      decemberLabel: `${new Date().getFullYear()}年 12月`,
      selected: [new Date().getFullYear() + 1, 0, 2],
      expectedYear: new Date().getFullYear() + 1,
    });

    await window.webContents.executeJavaScript(`
      window.__measureHomepage = function measureHomepage() {
        const surface = document.getElementById('home-bento').getBoundingClientRect();
        const protectedSelectors = {
          music: ['.music-copy', '.music-controls'],
          pomodoro: ['.pomodoro-readout', '.pomodoro-toggle', '.pomodoro-reset:not([hidden])'],
          recorder: ['.recorder-head', '.home-transcript:not([hidden])', '.recorder-controls'],
          windows: ['.tile-head', '.window-list'],
          note: ['.note-toolbar', '.note-body'],
          commands: ['.tile-head', '.command-add', '.command-list'],
        };
        const tiles = [...document.querySelectorAll('#home-bento [data-home-module]')]
          .filter((tile) => !tile.hidden)
          .map((tile) => {
            const rect = tile.getBoundingClientRect();
            const regions = (protectedSelectors[tile.dataset.homeModule] || [])
              .map((selector) => tile.querySelector(selector))
              .filter(Boolean)
              .map((node) => {
                const region = node.getBoundingClientRect();
                return { left: region.left, top: region.top, right: region.right, bottom: region.bottom };
              })
              .filter((region) => region.right > region.left && region.bottom > region.top);
            const outsideControls = [...tile.querySelectorAll('button:not([hidden]), input:not([hidden]), textarea:not([hidden])')]
              .filter((control) => {
                const child = control.getBoundingClientRect();
                return child.width > 0 && child.height > 0 && !(
                  child.left >= rect.left - 1 && child.right <= rect.right + 1
                  && child.top >= rect.top - 1 && child.bottom <= rect.bottom + 1
                );
              })
              .map((control) => {
                const controlRect = control.getBoundingClientRect();
                return {
                  name: control.id || control.className || control.tagName,
                  rect: { left: controlRect.left, top: controlRect.top, right: controlRect.right, bottom: controlRect.bottom },
                };
              });
            return {
              id: tile.dataset.homeModule,
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              controlsInside: outsideControls.length === 0,
              outsideControls,
              variant: tile.dataset.layoutVariant,
              area: Number(tile.dataset.layoutWidth) * Number(tile.dataset.layoutHeight),
              regions,
            };
          });
        return {
          surface: { left: surface.left, top: surface.top, right: surface.right, bottom: surface.bottom },
          tiles,
          sizeControls: [...document.querySelectorAll('#home-bento [data-widget-size-cycle]')].map((control) => ({
            hidden: control.hidden,
            disabled: control.disabled,
            tabIndex: control.tabIndex,
            size: control.dataset.currentSize,
          })),
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          ghostCount: document.querySelectorAll('.home-layout-ghost').length,
          animations: document.getElementById('home-bento').getAnimations().map((animation) => ({
            name: animation.animationName || '',
            playState: animation.playState,
            target: animation.effect?.target?.className || '',
            duration: animation.effect?.getTiming?.().duration,
          })),
        };
      };
      void 0;
    `);

    function assertHomepageMeasurement(measurement, visibleCount) {
      assert.equal(measurement.tiles.length, visibleCount);
      assert.equal(measurement.tiles.reduce((total, tile) => total + tile.area, 0), 48);
      const outside = measurement.tiles.filter((tile) => !tile.controlsInside)
        .map((tile) => `${tile.id}(${tile.variant}): ${JSON.stringify(tile.outsideControls)} tile=${JSON.stringify(tile.rect)}`);
      assert.deepEqual(outside, [], `组件控件必须保持在各自卡片内：${outside.join('; ')}`);
      assert.equal(measurement.reducedMotion, true);
      assert.equal(measurement.ghostCount, 0, '减弱动态效果时不得创建 Auto Layout ghost');
      assert.ok(
        measurement.animations.every((animation) => Number(animation.duration) <= 0.01),
        `减弱动态效果时不得创建有感布局动画：${JSON.stringify(measurement.animations)}`
      );
      measurement.tiles.forEach((tile) => {
        assert.ok(tile.rect.left >= measurement.surface.left - 1, `${tile.id} 越过首页左边界`);
        assert.ok(tile.rect.right <= measurement.surface.right + 1, `${tile.id} 越过首页右边界`);
        assert.ok(tile.rect.top >= measurement.surface.top - 1, `${tile.id} 越过首页上边界`);
        assert.ok(tile.rect.bottom <= measurement.surface.bottom + 1, `${tile.id} 越过首页下边界`);
        assert.ok(['mini', 'compact', 'wide', 'tall', 'full'].includes(tile.variant));
        for (let left = 0; left < tile.regions.length; left += 1) {
          for (let right = left + 1; right < tile.regions.length; right += 1) {
            const a = tile.regions[left];
            const b = tile.regions[right];
            const overlaps = a.left < b.right - 1 && a.right > b.left + 1
              && a.top < b.bottom - 1 && a.bottom > b.top + 1;
            assert.equal(overlaps, false, `${tile.id}(${tile.variant}) 的关键内容区域发生重叠：${JSON.stringify([a, b])}`);
          }
        }
      });
      for (let left = 0; left < measurement.tiles.length; left += 1) {
        for (let right = left + 1; right < measurement.tiles.length; right += 1) {
          const a = measurement.tiles[left].rect;
          const b = measurement.tiles[right].rect;
          const overlaps = a.left < b.right - 1 && a.right > b.left + 1
            && a.top < b.bottom - 1 && a.bottom > b.top + 1;
          assert.equal(overlaps, false, '首页组件矩形不得重叠');
        }
      }
      if (visibleCount < 6) {
        assert.ok(measurement.sizeControls.every((control) => control.hidden && control.disabled && control.tabIndex === -1));
      } else {
        assert.ok(measurement.sizeControls.every((control) => !control.hidden && !control.disabled && control.tabIndex === 0));
      }
    }

    for (const [width, height] of [[1240, 616], [1000, 576]]) {
      window.setSize(width, height);
      const matrix = await window.webContents.executeJavaScript(`
        (async () => {
          const ids = ['music', 'pomodoro', 'recorder', 'windows', 'note', 'commands'];
          ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
          const results = [];
          for (let count = 6; count >= 1; count -= 1) {
            document.getElementById('tab-button-home').click();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            results.push(window.__measureHomepage());
            if (count > 1) {
              document.getElementById('tab-button-settings').click();
              const input = document.querySelector('[data-settings-home-module="' + ids[6 - count] + '"]');
              input.checked = false;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          return results;
        })()
      `);
      matrix.forEach((measurement, index) => assertHomepageMeasurement(measurement, 6 - index));

      const finalWidgetGuard = await window.webContents.executeJavaScript(`
        (async () => {
          document.getElementById('tab-button-settings').click();
          const enabled = [...document.querySelectorAll('[data-settings-home-module]')].find((input) => input.checked);
          enabled.checked = false;
          enabled.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            checked: enabled.checked,
            visibleCount: window.NotchHome.getVisibility().visibleIds.length,
            storedCount: JSON.parse(localStorage.getItem('notch-home-hidden-modules-v1')).length,
            message: document.getElementById('status-toast-message').textContent,
          };
        })()
      `);
      assert.equal(finalWidgetGuard.checked, true);
      assert.equal(finalWidgetGuard.visibleCount, 1);
      assert.equal(finalWidgetGuard.storedCount, 5);
      assert.match(finalWidgetGuard.message, /至少保留一个/);
    }

    const transactionAudit = await window.webContents.executeJavaScript(`
      (() => {
        const ids = ['music', 'pomodoro', 'recorder', 'windows', 'note', 'commands'];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        const first = window.NotchHome.setModuleVisible('windows', false);
        const second = window.NotchHome.setModuleVisible('note', false);
        const rapidHidden = [...window.NotchHome.getVisibility().hiddenIds];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        window.NotchHome.setModuleVisible('commands', false);
        window.NotchHome.setModuleVisible('commands', true);
        window.NotchHome.setModuleVisible('commands', false);
        let eventCount = 0;
        const onChange = () => { eventCount += 1; };
        document.addEventListener('notch:home-modules-changed', onChange);
        const storageBeforeNoop = localStorage.getItem('notch-home-hidden-modules-v1');
        const noop = window.NotchHome.setModuleVisible('commands', false);
        const noOpStorageStable = storageBeforeNoop === localStorage.getItem('notch-home-hidden-modules-v1');
        document.removeEventListener('notch:home-modules-changed', onChange);
        const beforeRollback = {
          hidden: JSON.stringify(window.NotchHome.getVisibility().hiddenIds),
          stored: localStorage.getItem('notch-home-hidden-modules-v1'),
          visible: [...document.querySelectorAll('[data-home-module]')].filter((tile) => !tile.hidden).map((tile) => tile.dataset.homeModule).join(','),
          styles: [...document.querySelectorAll('[data-home-module]')].map((tile) => tile.getAttribute('style')).join('|'),
        };
        const originalResolver = window.NotchDomain.resolveHomeWidgetLayout;
        window.NotchDomain.resolveHomeWidgetLayout = () => null;
        const rollback = window.NotchHome.setModuleVisible('music', false);
        window.NotchDomain.resolveHomeWidgetLayout = originalResolver;
        const afterRollback = {
          hidden: JSON.stringify(window.NotchHome.getVisibility().hiddenIds),
          stored: localStorage.getItem('notch-home-hidden-modules-v1'),
          visible: [...document.querySelectorAll('[data-home-module]')].filter((tile) => !tile.hidden).map((tile) => tile.dataset.homeModule).join(','),
          styles: [...document.querySelectorAll('[data-home-module]')].map((tile) => tile.getAttribute('style')).join('|'),
        };
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        const originalWorkspace = window.NotchWorkspace;
        window.NotchWorkspace = { ...originalWorkspace, isRecordingActive: () => true };
        document.dispatchEvent(new CustomEvent('notch:recording-state-changed', { detail: { active: true } }));
        const recordingGuard = window.NotchHome.setModuleVisible('recorder', false);
        window.NotchWorkspace = originalWorkspace;
        const durations = [];
        for (let index = 0; index < 100; index += 1) {
          const start = performance.now();
          window.NotchHome.setModuleVisible('note', index % 2 === 0 ? false : true);
          durations.push(performance.now() - start);
        }
        durations.sort((a, b) => a - b);
        return {
          first, second, rapidHidden, noop, eventCount,
          noOpStorageStable,
          rollback, rollbackStable: JSON.stringify(beforeRollback) === JSON.stringify(afterRollback),
          recordingGuard,
          p95: durations[Math.floor(durations.length * .95)],
          maximum: durations[durations.length - 1],
          animationCount: document.getElementById('home-bento').getAnimations().length,
        };
      })()
    `);
    assert.equal(transactionAudit.first.ok, true);
    assert.equal(transactionAudit.second.ok, true);
    assert.deepEqual(transactionAudit.rapidHidden, ['windows', 'note']);
    assert.equal(transactionAudit.noop.changed, false);
    assert.equal(transactionAudit.eventCount, 0);
    assert.equal(transactionAudit.noOpStorageStable, true);
    assert.equal(transactionAudit.rollback.error, 'layout_invalid');
    assert.equal(transactionAudit.rollbackStable, true);
    assert.equal(transactionAudit.recordingGuard.error, 'recording_active');
    assert.ok(transactionAudit.p95 < 16, `显隐事务 p95 ${transactionAudit.p95.toFixed(2)}ms 超过 16ms`);
    assert.ok(transactionAudit.maximum < 50, `显隐事务最长 ${transactionAudit.maximum.toFixed(2)}ms 超过 50ms`);
    assert.ok(transactionAudit.animationCount <= 1);

    const persistenceAndRecorderAudit = await window.webContents.executeJavaScript(`
      (() => {
        const ids = ['music', 'pomodoro', 'recorder', 'windows', 'note', 'commands'];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        const originalSetItem = Storage.prototype.setItem;
        const storedBefore = localStorage.getItem('notch-home-hidden-modules-v1');
        Storage.prototype.setItem = function setItem(key, value) {
          if (key === 'notch-home-hidden-modules-v1') throw new Error('simulated quota failure');
          return originalSetItem.call(this, key, value);
        };
        const degraded = window.NotchHome.setModuleVisible('windows', false);
        const degradedState = window.NotchHome.getVisibility();
        const degradedStatus = document.getElementById('settings-home-module-status').textContent;
        const degradedStorageStable = storedBefore === localStorage.getItem('notch-home-hidden-modules-v1');
        ['music', 'pomodoro', 'recorder', 'note'].forEach((id) => {
          window.NotchHome.setModuleVisible(id, false);
        });
        const rejectedWhileDirty = window.NotchHome.setModuleVisible('commands', false);
        Storage.prototype.setItem = originalSetItem;
        const recovered = window.NotchHome.setModuleVisible('music', true);
        const recoveredState = window.NotchHome.getVisibility();
        const recoveredStored = JSON.parse(localStorage.getItem('notch-home-hidden-modules-v1'));

        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        const recorderHidden = window.NotchHome.setModuleVisible('recorder', false);
        const originalWorkspace = window.NotchWorkspace;
        window.NotchWorkspace = { ...originalWorkspace, isRecordingActive: () => true };
        document.dispatchEvent(new CustomEvent('notch:recording-state-changed', { detail: { active: true } }));
        const recorderSwitch = document.querySelector('[data-settings-home-module="recorder"]');
        const hiddenSwitchEnabled = !recorderSwitch.disabled && !recorderSwitch.checked;
        const recorderRestored = window.NotchHome.setModuleVisible('recorder', true);
        document.dispatchEvent(new CustomEvent('notch:recording-state-changed', { detail: { active: true } }));
        const visibleSwitchLocked = recorderSwitch.disabled && recorderSwitch.checked;
        const recordingsActionAvailable = !document.getElementById('recording-new').disabled;
        window.NotchWorkspace = originalWorkspace;
        document.dispatchEvent(new CustomEvent('notch:recording-state-changed', { detail: { active: false } }));

        const noteInput = document.getElementById('home-note');
        noteInput.focus();
        const noteTile = noteInput.closest('[data-home-module]');
        window.NotchHome.setModuleVisible('note', false);
        const focusReleased = !noteTile.contains(document.activeElement)
          && noteTile.hidden
          && noteTile.querySelector('[data-widget-size-cycle]').tabIndex === -1;
        window.NotchHome.setModuleVisible('note', true);
        return {
          degraded,
          degradedPersisted: degradedState.persisted,
          degradedStorageStable,
          degradedStatus,
          rejectedWhileDirty,
          recovered,
          recoveredPersisted: recoveredState.persisted,
          recoveredStored,
          recorderHidden,
          hiddenSwitchEnabled,
          recorderRestored,
          visibleSwitchLocked,
          recordingsActionAvailable,
          focusReleased,
        };
      })()
    `);
    assert.equal(persistenceAndRecorderAudit.degraded.ok, true);
    assert.equal(persistenceAndRecorderAudit.degraded.persisted, false);
    assert.equal(persistenceAndRecorderAudit.degradedPersisted, false);
    assert.equal(persistenceAndRecorderAudit.degradedStorageStable, true);
    assert.match(persistenceAndRecorderAudit.degradedStatus, /仅当前会话/);
    assert.equal(persistenceAndRecorderAudit.rejectedWhileDirty.ok, false);
    assert.equal(persistenceAndRecorderAudit.rejectedWhileDirty.persisted, false);
    assert.equal(persistenceAndRecorderAudit.recovered.ok, true);
    assert.equal(persistenceAndRecorderAudit.recovered.persisted, true);
    assert.equal(persistenceAndRecorderAudit.recoveredPersisted, true);
    assert.ok(Array.isArray(persistenceAndRecorderAudit.recoveredStored));
    assert.equal(persistenceAndRecorderAudit.recorderHidden.ok, true);
    assert.equal(persistenceAndRecorderAudit.hiddenSwitchEnabled, true);
    assert.equal(persistenceAndRecorderAudit.recorderRestored.ok, true);
    assert.equal(persistenceAndRecorderAudit.visibleSwitchLocked, true);
    assert.equal(persistenceAndRecorderAudit.recordingsActionAvailable, true);
    assert.equal(persistenceAndRecorderAudit.focusReleased, true);

    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    const panelMotionAudit = await window.webContents.executeJavaScript(`
      (async () => {
        const appSurface = document.getElementById('app');
        appSurface.classList.remove('expanded', 'opening', 'closing');
        appSurface.classList.add('collapsed');
        await new Promise((resolve) => setTimeout(resolve, 520));
        const waitForClass = async (name) => {
          const deadline = performance.now() + 5000;
          while (performance.now() < deadline) {
            if (appSurface.classList.contains(name)) return true;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return false;
        };
        const readPanelMorph = () => {
          const panel = document.getElementById('panel');
          const board = document.getElementById('panels');
          const shellAnimations = panel.getAnimations({ subtree: true }).filter((animation) => {
            const clips = animation.effect?.getKeyframes?.()
              .map((frame) => frame.clipPath)
              .filter((value) => value && value !== 'none') || [];
            return new Set(clips).size > 1;
          });
          const contentAnimations = board.getAnimations();
          return {
            active: shellAnimations.length > 0,
            durations: shellAnimations.map((animation) => Number(animation.effect?.getTiming?.().duration) || 0),
            easings: shellAnimations.map((animation) => String(animation.effect?.getTiming?.().easing || '')),
            contentClipAnimationCount: contentAnimations.filter((animation) => {
              const clips = animation.effect?.getKeyframes?.()
                .map((frame) => frame.clipPath)
                .filter((value) => value && value !== 'none') || [];
              return new Set(clips).size > 1;
            }).length,
            contentTransformAnimationCount: contentAnimations.filter((animation) => {
              const transforms = animation.effect?.getKeyframes?.()
                .map((frame) => frame.transform)
                .filter((value) => value && value !== 'none') || [];
              return new Set(transforms).size > 1;
            }).length,
          };
        };
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }));
        const opened = await waitForClass('expanded');
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const openingMorph = readPanelMorph();
        const tileEntranceAnimations = [...document.querySelectorAll('#home-bento [data-home-module]')]
          .flatMap((tile) => tile.getAnimations())
          .filter((animation) => animation.animationName === 'bento-masonry-in').length;
        const contentLayerHasScale = [
          document.querySelector('.panel > .topbar'),
          document.querySelector('.panel > .panels'),
        ].filter(Boolean).some((layer) => layer.getAnimations().some((animation) => (
          animation.effect?.getKeyframes?.().some((frame) => {
            if (!frame.transform || frame.transform === 'none') return false;
            const matrix = new DOMMatrixReadOnly(frame.transform);
            const scaleX = Math.hypot(matrix.a, matrix.b);
            const scaleY = Math.hypot(matrix.c, matrix.d);
            return Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001;
          })
        )));
        const masonryReveal = document.getElementById('home-bento').classList.contains('masonry-reveal');
        await new Promise((resolve) => setTimeout(resolve, 520));
        const board = document.getElementById('panels');
        const morphShell = document.getElementById('panel');
        let closingMorphEndedAt = 0;
        let collapsedClassAppliedAt = 0;
        const closingFrameGaps = [];
        let previousClosingFrame = performance.now();
        let sampleClosingFrames = true;
        const sampleClosingFrame = (now) => {
          closingFrameGaps.push(now - previousClosingFrame);
          previousClosingFrame = now;
          if (sampleClosingFrames) requestAnimationFrame(sampleClosingFrame);
        };
        requestAnimationFrame(sampleClosingFrame);
        const onClosingTransitionEnd = (event) => {
          if (event.target === morphShell
            && event.pseudoElement === '::before'
            && event.propertyName === 'clip-path') {
            closingMorphEndedAt = performance.now();
          }
        };
        morphShell.addEventListener('transitionend', onClosingTransitionEnd);
        const collapseObserver = new MutationObserver(() => {
          if (!collapsedClassAppliedAt && appSurface.classList.contains('collapsed')) {
            collapsedClassAppliedAt = performance.now();
          }
        });
        collapseObserver.observe(appSurface, { attributes: true, attributeFilter: ['class'] });
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }));
        const closing = await waitForClass('closing');
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const closingMorph = readPanelMorph();
        // 内容必须跟随底板缩小，并在整个收起形变进行到一半时完全退场，
        // 避免原尺寸卡片越过正在缩小的白色底板形成重影。
        await new Promise((resolve) => setTimeout(resolve, 220));
        const closingBoardStyle = getComputedStyle(board);
        const closingBoardTransform = closingBoardStyle.transform;
        const closingBoardMatrix = closingBoardTransform === 'none'
          ? new DOMMatrixReadOnly()
          : new DOMMatrixReadOnly(closingBoardTransform);
        const closingHalfContentOpacity = Number(closingBoardStyle.opacity);
        const closingHalfContentScale = Math.hypot(closingBoardMatrix.a, closingBoardMatrix.b);
        const collapsed = await waitForClass('collapsed');
        sampleClosingFrames = false;
        morphShell.removeEventListener('transitionend', onClosingTransitionEnd);
        collapseObserver.disconnect();
        return {
          opened,
          closing,
          collapsed,
          tileEntranceAnimations,
          contentLayerHasScale,
          masonryReveal,
          openingMorph,
          closingMorph,
          closingHalfContentOpacity,
          closingHalfContentScale,
          closingTailGapMs: closingMorphEndedAt && collapsedClassAppliedAt
            ? collapsedClassAppliedAt - closingMorphEndedAt
            : null,
          closingMaxFrameGapMs: closingFrameGaps.length ? Math.max(...closingFrameGaps) : null,
        };
      })()
    `);
    assert.equal(panelMotionAudit.opened, true);
    assert.equal(panelMotionAudit.collapsed, true);
    assert.equal(panelMotionAudit.tileEntranceAnimations, 0, '展开时不得再同时启动六张卡片的错峰缩放入场');
    assert.equal(panelMotionAudit.masonryReveal, false, '首页卡片不应在每次展开时重播入场');
    assert.equal(panelMotionAudit.contentLayerHasScale, true, '顶栏与卡片内容必须跟随白色底板缩放');
    assert.equal(panelMotionAudit.openingMorph.active, true, 'Space 展开必须从刘海形状连续放大，不能整块硬切显示');
    assert.equal(panelMotionAudit.closing, true);
    assert.equal(panelMotionAudit.closingMorph.active, true, 'Space 收起必须连续缩回刘海形状，不能直接消失');
    assert.equal(panelMotionAudit.openingMorph.contentClipAnimationCount, 0, '展开不得在复杂内容层持续重绘 clip-path');
    assert.equal(panelMotionAudit.closingMorph.contentClipAnimationCount, 0, '收起不得在复杂内容层持续重绘 clip-path');
    assert.ok(panelMotionAudit.openingMorph.contentTransformAnimationCount >= 1, '展开时内容层必须跟随底板放大');
    assert.ok(panelMotionAudit.closingMorph.contentTransformAnimationCount >= 1, '收起时内容层必须跟随底板缩小');
    assert.ok(
      panelMotionAudit.closingHalfContentOpacity <= 0.05,
      `收起至一半时内容必须消失，当前透明度 ${panelMotionAudit.closingHalfContentOpacity}`
    );
    assert.ok(
      panelMotionAudit.closingHalfContentScale >= 0.45 && panelMotionAudit.closingHalfContentScale <= 0.62,
      `收起至一半时内容应缩至约一半，当前缩放 ${panelMotionAudit.closingHalfContentScale}`
    );
    [...panelMotionAudit.openingMorph.durations, ...panelMotionAudit.closingMorph.durations].forEach((duration) => {
      assert.ok(duration >= 340 && duration <= 520, `刘海形变时长应自然可见，当前为 ${duration}ms`);
    });
    [...panelMotionAudit.openingMorph.easings, ...panelMotionAudit.closingMorph.easings].forEach((easing) => {
      assert.notEqual(easing, 'linear', '刘海形变必须使用缓入缓出曲线');
    });
    assert.ok(
      panelMotionAudit.closingTailGapMs !== null
        && panelMotionAudit.closingTailGapMs >= 0
        && panelMotionAudit.closingTailGapMs <= 20,
      `缩回动画结束后应立即折叠原生窗口，当前额外停顿 ${panelMotionAudit.closingTailGapMs}ms`
    );
    assert.ok(
      panelMotionAudit.closingMaxFrameGapMs !== null && panelMotionAudit.closingMaxFrameGapMs <= 24,
      `缩回动画不得出现明显掉帧，当前最长帧间隔 ${panelMotionAudit.closingMaxFrameGapMs}ms`
    );

    const lifecycleAudit = await window.webContents.executeJavaScript(`
      (async () => {
        const ids = ['music', 'pomodoro', 'recorder', 'windows', 'note', 'commands'];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        document.getElementById('tab-button-home').click();
        document.getElementById('app').classList.remove('collapsed', 'closing', 'opening');
        document.getElementById('app').classList.add('expanded');
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: true } }));
        let windowScans = 0;
        window.notchAPI = {
          listWindows: async () => { windowScans += 1; return { items: [] }; },
        };
        await new Promise((resolve) => setTimeout(resolve, 30));
        windowScans = 0;
        window.NotchHome.setModuleVisible('windows', false);
        await window.NotchWorkspace.refreshWindows(true);
        await window.NotchWorkspace.refreshWindows(true);
        const scansWhileHidden = windowScans;
        window.NotchHome.setModuleVisible('windows', true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const scansAfterRestore = windowScans;

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.NotchHome.setModuleVisible('music', false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const musicStopped = document.getElementById('music-color-bends').dataset.effectRunning === 'false';
        window.NotchHome.setModuleVisible('music', true);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const musicIdleAfterRestore = document.getElementById('music-color-bends').dataset.effectRunning === 'false';
        const musicTile = document.getElementById('music-color-bends').parentElement;
        musicTile.dispatchEvent(new PointerEvent('pointerenter'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const musicAnimatingOnHover = document.getElementById('music-color-bends').dataset.effectRunning === 'true';
        musicTile.dispatchEvent(new PointerEvent('pointerleave'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const musicStoppedAfterHover = document.getElementById('music-color-bends').dataset.effectRunning === 'false';

        const minutes = document.getElementById('pomodoro-minutes');
        const seconds = document.getElementById('pomodoro-seconds');
        minutes.value = '00';
        seconds.value = '10';
        seconds.dispatchEvent(new Event('blur'));
        document.getElementById('pomodoro-toggle').click();
        const before = Number(minutes.value) * 60 + Number(seconds.value);
        window.NotchHome.setModuleVisible('pomodoro', false);
        await new Promise((resolve) => setTimeout(resolve, 1150));
        const whileHidden = Number(minutes.value) * 60 + Number(seconds.value);
        window.NotchHome.setModuleVisible('pomodoro', true);
        const after = Number(minutes.value) * 60 + Number(seconds.value);
        document.getElementById('pomodoro-reset').click();
        return {
          scansWhileHidden,
          scansAfterRestore,
          musicStopped,
          musicIdleAfterRestore,
          musicAnimatingOnHover,
          musicStoppedAfterHover,
          before,
          whileHidden,
          after,
        };
      })()
    `);
    assert.equal(lifecycleAudit.scansWhileHidden, 0);
    assert.equal(lifecycleAudit.scansAfterRestore, 1);
    assert.equal(lifecycleAudit.musicStopped, true);
    assert.equal(lifecycleAudit.musicIdleAfterRestore, true);
    assert.equal(lifecycleAudit.musicAnimatingOnHover, true);
    assert.equal(lifecycleAudit.musicStoppedAfterHover, true);
    assert.ok(lifecycleAudit.whileHidden < lifecycleAudit.before, '番茄钟隐藏后应继续计时');
    assert.equal(lifecycleAudit.after, lifecycleAudit.whileHidden);

    const idlePerformanceAudit = await window.webContents.executeJavaScript(`
      (async () => {
        const appSurface = document.getElementById('app');
        const canvas = document.getElementById('music-color-bends');
        document.getElementById('tab-button-home').click();
        appSurface.classList.remove('collapsed');
        appSurface.classList.add('expanded');
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: true } }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const stoppedWhileExpandedIdle = canvas.dataset.effectRunning === 'false';
        const hasInfinitePanelEffect = document.getElementById('panel').getAnimations({ subtree: true })
          .some((animation) => animation.animationName === 'bento-border-breathe'
            && animation.effect?.getTiming?.().iterations === Infinity);
        const panelBackdropFilter = getComputedStyle(document.getElementById('panel'), '::before').backdropFilter;
        appSurface.classList.remove('expanded');
        appSurface.classList.add('collapsed');
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: false } }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const stoppedWhileCollapsed = canvas.dataset.effectRunning === 'false';
        appSurface.classList.remove('collapsed');
        appSurface.classList.add('expanded');
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: true } }));
        return {
          stoppedWhileExpandedIdle,
          stoppedWhileCollapsed,
          hasInfinitePanelEffect,
          panelBackdropFilter,
        };
      })()
    `);
    assert.equal(idlePerformanceAudit.stoppedWhileExpandedIdle, true, '首页静置时 WebGL 不得保留空转 RAF');
    assert.equal(idlePerformanceAudit.stoppedWhileCollapsed, true, '收起后 WebGL 不得保留空转 RAF');
    assert.equal(idlePerformanceAudit.hasInfinitePanelEffect, false, '展开后不得运行大面积无限边框滤镜动画');
    assert.equal(idlePerformanceAudit.panelBackdropFilter, 'none', '近乎不透明的面板不得使用大面积实时背景模糊');

    const autoLayoutMotionAudit = await window.webContents.executeJavaScript(`
      (async () => {
        const ids = ['music', 'pomodoro', 'recorder', 'windows', 'note', 'commands'];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        document.getElementById('tab-button-home').click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const sizeButton = document.querySelector('[data-widget-size-cycle="music"]');
        const beforeSize = sizeButton.dataset.currentSize;
        sizeButton.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const ghosts = [...document.querySelectorAll('.home-layout-ghost')];
        const tileAnimations = [...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')]
          .flatMap((tile) => tile.getAnimations());
        const tileDurations = tileAnimations
          .map((animation) => Number(animation.effect?.getTiming?.().duration) || 0)
          .filter((duration) => duration > 0);
        const animatedOpacities = tileAnimations.flatMap((animation) => (
          animation.effect?.getKeyframes?.().map((frame) => Number(frame.opacity)).filter(Number.isFinite) || []
        ));
        const minimumTileOpacity = animatedOpacities.length ? Math.min(...animatedOpacities) : 1;
        const realTileHasScale = [...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')]
          .some((tile) => tile.getAnimations().some((animation) => (
            animation.effect?.getKeyframes?.().some((frame) => /scale/.test(String(frame.transform || '')))
          )));
        const during = {
          beforeSize,
          afterSize: sizeButton.dataset.currentSize,
          ghostCount: ghosts.length,
          tileDurations,
          minimumTileOpacity,
          realTileHasScale,
        };
        await new Promise((resolve) => setTimeout(resolve, 700));
        const ghostsAfter = document.querySelectorAll('.home-layout-ghost').length;
        const tileAnimationsAfter = [...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')]
          .reduce((count, tile) => count + tile.getAnimations().length, 0);
        sizeButton.click();
        sizeButton.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const rapidGhostIds = [...document.querySelectorAll('.home-layout-ghost')]
          .map((ghost) => ghost.dataset.homeLayoutGhost);
        const rapidDuplicateGhosts = new Set(rapidGhostIds).size !== rapidGhostIds.length;
        const rapidMaxTileAnimations = Math.max(...[...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')]
          .map((tile) => tile.getAnimations().length));
        await new Promise((resolve) => setTimeout(resolve, 700));
        return {
          ...during,
          ghostsAfter,
          tileAnimationsAfter,
          rapidDuplicateGhosts,
          rapidMaxTileAnimations,
          rapidGhostsAfter: document.querySelectorAll('.home-layout-ghost').length,
        };
      })()
    `);
    assert.notEqual(autoLayoutMotionAudit.afterSize, autoLayoutMotionAudit.beforeSize);
    assert.equal(autoLayoutMotionAudit.ghostCount, 0, '尺寸切换不得用空外壳遮成黑块');
    assert.ok(
      autoLayoutMotionAudit.tileDurations.length > 0
        && autoLayoutMotionAudit.tileDurations.every((duration) => duration >= 500 && duration <= 650),
      'Auto Layout 应保留过程感，也不得拖沓'
    );
    assert.ok(autoLayoutMotionAudit.minimumTileOpacity >= 0.72, '重排期间真实卡片不得熄灭成黑块');
    assert.equal(autoLayoutMotionAudit.realTileHasScale, true, '真实卡片应恢复连续 FLIP 几何过渡');
    assert.equal(autoLayoutMotionAudit.ghostsAfter, 0, 'Auto Layout ghost 必须在动画后清理');
    assert.equal(autoLayoutMotionAudit.tileAnimationsAfter, 0, '重排动画结束后不得残留组件动画');
    assert.equal(autoLayoutMotionAudit.rapidDuplicateGhosts, false, '连续切换必须先清理上一轮 Auto Layout ghost');
    assert.ok(autoLayoutMotionAudit.rapidMaxTileAnimations <= 1, '连续切换不得叠加多轮组件动画');
    assert.equal(autoLayoutMotionAudit.rapidGhostsAfter, 0, '连续切换结束后不得残留 Auto Layout ghost');
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
  }
}

main().then(
  () => app.quit(),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
