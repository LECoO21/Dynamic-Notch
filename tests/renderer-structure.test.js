const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const workspaceJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workspace.js'), 'utf8');
const effectsJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'effects.js'), 'utf8');
const referenceThemeCss = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'reference-theme.css'), 'utf8');

test('clipboard rows define both favorite icons before rendering entries', () => {
  assert.match(appJs, /const starOutlineSvg\s*=/);
  assert.match(appJs, /const starFilledSvg\s*=/);
});

test('notes have a dedicated top-level tab and management panel', () => {
  assert.match(html, /data-tab="notes"/);
  assert.match(html, /id="tab-notes"/);
  assert.match(html, /id="notes-search"/);
  assert.match(html, /id="notes-list"/);
  assert.match(html, /id="notes-detail"/);
});

test('home scratch note keeps only the save action', () => {
  const homeNote = html.match(/<section class="tile home-note"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(homeNote, /id="note-save-btn"/);
  assert.doesNotMatch(homeNote, /id="note-library-btn"/);
  assert.doesNotMatch(homeNote, /id="note-library"/);
});

test('recordings expose in-page API settings and create a live draft while recording', () => {
  assert.match(html, /id="recording-configure"/);
  assert.match(workspaceJs, /function beginRecordingDraft\(\)/);
  assert.match(workspaceJs, /recordingLiveTranscript/);
  assert.match(workspaceJs, /configure-transcription/);
});

test('a live recording can be paused, resumed, and stopped from the recordings tab', () => {
  assert.match(workspaceJs, /recording-live-pause/);
  assert.match(workspaceJs, /recording-live-stop/);
  assert.match(workspaceJs, /togglePauseRecording/);
  assert.match(workspaceJs, /stopRecording/);
});

test('homepage visibility has one storage key, exact validation, and lifecycle events', () => {
  assert.match(appJs, /notch-home-hidden-modules-v1/);
  assert.match(appJs, /validateHomeWidgetLayout/);
  assert.match(appJs, /window\.NotchHome\s*=/);
  assert.match(appJs, /notch:home-modules-changed/);
  assert.match(appJs, /notch:home-layout-error/);
  assert.match(appJs, /new Set\(homeTiles\.map\(\(tile\) => tile\.dataset\.homeModule\)\)/);
});

test('settings exposes exactly one switch for every homepage widget', () => {
  const switches = [...html.matchAll(/data-settings-home-module="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(switches, [
    'music', 'pomodoro', 'recorder', 'windows', 'note', 'commands',
  ]);
  assert.match(workspaceJs, /isRecordingActive/);
  assert.match(workspaceJs, /recording_active/);
  assert.match(workspaceJs, /at_least_one_required/);
});

test('mirror controls and renderer logic are absent', () => {
  assert.doesNotMatch(html, /home-mirror|settings-mirror/);
  assert.doesNotMatch(appJs, /startMirror|stopMirror|mirrorStage|mirrorStream/);
  assert.doesNotMatch(workspaceJs, /settingsMirror|applySettingsMirrorCover/);
});

test('topbar restores the original sliding segmented control without side identity blocks', () => {
  assert.doesNotMatch(html, /topbar-brand|topbar-status|collapse-btn/);
  assert.match(html, /<span class="tab-label">首页<\/span>/);
  assert.match(html, /<span class="tab-label">设置<\/span>/);
  assert.match(
    html,
    /<span class="tab-indicator" id="tab-indicator" aria-hidden="true"><\/span>/
  );
  assert.doesNotMatch(html, /shape-rendering="geometricPrecision"|M14 14 C31 14/);
  assert.match(
    referenceThemeCss,
    /\.tab-indicator\s*\{[\s\S]*?top:\s*3px;[\s\S]*?height:\s*28px;[\s\S]*?border-radius:\s*var\(--r-pill\)/
  );
  assert.match(referenceThemeCss, /All labels are visible again/);
});

test('board navigation has separate primary and utility glass groups', () => {
  const groups = [...html.matchAll(
    /<div class="tabs-group tabs-group-(primary|utilities)" role="presentation">([\s\S]*?)<\/div>/g
  )];
  assert.deepEqual(groups.map((group) => group[1]), ['primary', 'utilities']);
  const tabsInGroup = (group) => [...group[2].matchAll(/data-tab="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(tabsInGroup(groups[0]), ['home', 'todo', 'clip', 'notes', 'links', 'recordings']);
  assert.deepEqual(tabsInGroup(groups[1]), ['credentials', 'settings']);
  assert.equal([...html.matchAll(/id="tab-indicator"/g)].length, 1);
});

test('hidden visual widgets stop presentation-only background work', () => {
  assert.match(effectsJs, /setEnabled/);
  assert.match(effectsJs, /notch:home-modules-changed/);
  assert.match(workspaceJs, /NotchHome\?\.isVisible/);
});
