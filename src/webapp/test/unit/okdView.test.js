import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const index = fs.readFileSync(path.join(root, 'views/index.ejs'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views/uponlanxyz-web.ejs'), 'utf8');

afterEach(() => vi.useRealTimers());

function okdHarness() {
    const nodes = new Map(); const requests = [];
    const timers = new Map(); let timerId = 0;
    const $ = (selector) => {
      if (typeof selector !== 'string') return selector;
      if (!nodes.has(selector)) {
        const node = { length: 1, value: '', shown: false, handlers: {}, renders: 0, disabled: false };
        node[0] = node;
        for (const method of ['text', 'attr', 'toggleClass', 'removeClass', 'addClass', 'replaceWith', 'empty', 'show']) node[method] = () => node;
        node.text = (value) => { node.textValue = value; return node; };
        node.hasClass = () => selector.includes('[id$=') ? [...nodes.values()].some((item) => item.shown) : node.shown;
        node.html = () => { node.renders += 1; return node; };
        node.val = (value) => { if (value === undefined) return node.value; node.value = value; return node; };
        node.prop = (name, value) => { if (name === 'disabled') node.disabled = value; return node; };
        for (const event of ['click', 'change']) node[event] = (callback) => { node.handlers[event] = callback; return node; };
        node.on = (event, callback) => { node.handlers[event] = callback; return node; };
        node.data = () => 'operations';
         node.modal = () => node;
         node.tab = () => node;
        nodes.set(selector, node);
      }
      return nodes.get(selector);
    };
    const pending = new Set();
    const socket = { connected: true, emit: (event, ...args) => requests.push({ event, callback: args.at(-1), payload: typeof args[0] === 'function' ? undefined : structuredClone(args[0]) }) };
    socket.volatile = socket;
    socket.timeout = (ms) => ({ emit: (event, payload, callback) => {
      let settled = false;
      const finish = (err, result) => { if (settled) return; settled = true; clearTimeout(timer); pending.delete(fail); callback(err, result); };
      const fail = () => finish(new Error('transport failed'));
      const timer = setTimeout(fail, ms); pending.add(fail);
      socket.emit(event, payload, (result) => finish(null, result));
    } });
    socket.disconnect = () => { socket.connected = false; for (const fail of pending) fail(); };
    const source = view.slice(view.indexOf('const OKD_RELEASE'), view.indexOf('//// Render WOL page'));
    const ui = new Function('$', 'socket', 'setTimeout', 'clearTimeout', 'showToast', `${source}
      okdPageActive = true; okdProfile = okdNewProfile(); okdExistingId = okdProfile.id; okdSavedRelease = okdProfile.release; okdRevision = 'revision'; okdMarkClean(okdProfile);
      let draft = structuredClone(okdProfile); okdReadForm = () => draft;
       okdPullSecretStatus = {status:'ready',source:'default',exists:false,writable:true};
      return { render: okdRenderForm, refresh: okdRefreshJobs, save: () => okdSaveProfile(draft),
         tools: okdRefreshTools,
         state: () => ({ profile:okdProfile, id:okdExistingId, revision:okdRevision, preflight:okdPreflight, baseline:okdBaseline, draft, tools:okdToolStatus, toolsError:okdToolError, secretSaving:okdPullSecretSaving, secretMessage:okdPullSecretMessage }),
         dirty: () => { draft.cluster_name = 'unsaved'; },
         changeRelease: () => { draft.release = '4.22.0-okd-scos.9'; },
         select: (id) => { okdViewEpoch += 1; okdStopToolPoll(); okdExistingId = id; okdRevision = 'other'; draft = {...draft,id}; okdProfile = draft; },
         leave: () => { okdPageActive = false; okdViewEpoch += 1; okdStopToolPoll(); } };
    `)($, socket, (callback) => { timers.set(++timerId, callback); return timerId; }, (id) => timers.delete(id), () => {});
    const reply = (event, data) => { const index = requests.findIndex((item) => item.event === event); expect(index).toBeGreaterThanOrEqual(0); requests.splice(index, 1)[0].callback({ ok: true, data }); };
    const refreshReplies = (ready) => {
      reply('okd:jobs:status', { current: null, blocking: null, history: [] });
      reply('okd:versions:list', []); reply('okd:operations:monitor:status', null);
      reply('okd:jobs:preflight', { ready, errors: ready ? [] : [{ message: 'Add pull secret.' }] });
    };
    return { $, ui, socket, requests, reply, refreshReplies, timers };
}

describe('OKD view wiring', () => {
  it('uses the acknowledged saved release, not an unsaved form/dropdown value', () => {
    const { ui, requests, reply } = okdHarness(); ui.render(); ui.save();
    const saved = { ...requests.find((r) => r.event === 'okd:save').payload.profile, revision: 'saved' };
    ui.changeRelease(); reply('okd:save', saved);
    expect(ui.state().draft.release).toBe('4.22.0-okd-scos.9');
    expect(requests.find((r) => r.event === 'okd:tools:status').payload).toBe('5.0.0-okd-scos.1');
  });
  it('loads saved-release progress independently of slow/failed YAML and updates only tool DOM', () => {
    const { $, ui, requests, reply, timers } = okdHarness(); ui.render();
    $('#okd-edit').handlers.click();
    expect(requests.find((r) => r.event === 'okd:tools:status').payload).toBe('5.0.0-okd-scos.1');
    $('[id^="okd-"][id$="-modal"]').handlers['show.bs.modal']();
    $('#okd-install-config').val('draft YAML'); $('#okd-pull-secret-input').val('dummy draft');
    const renders = $('#pagecontent').renders;
    reply('okd:tools:status', { release: '5.0.0-okd-scos.1', state: 'preparing', tools: { installer: { state: 'ready', ready: true }, oc: { state: 'preparing' } } });
    expect($('#okd-profile-generate-reason').textValue).toContain('preparing');
    expect(timers.size).toBe(1); const poll = [...timers.values()][0]; timers.clear(); poll();
    requests.find((r) => r.event === 'okd:configs:get').callback({ ok: false, message: 'YAML unavailable' });
    reply('okd:tools:status', { release: '5.0.0-okd-scos.1', state: 'failed', tools: { installer: { ready: true }, oc: { state: 'failed', ready: false } } });
    expect($('#okd-profile-generate-reason').textValue).toContain('Save the profile to retry');
    expect(timers.size).toBe(0); expect($('#pagecontent').renders).toBe(renders);
    expect($('#okd-install-config').val()).toBe('draft YAML'); expect($('#okd-pull-secret-input').val()).toBe('dummy draft');
  });

  it.each(['selection', 'page'])('ignores late tools replies and clears scheduled polling after %s changes', (change) => {
    const { ui, reply, requests, timers } = okdHarness(); ui.render(); ui.tools();
    reply('okd:tools:status', { release: '5.0.0-okd-scos.1', state: 'preparing', tools: {} });
    expect(timers.size).toBe(1); ui.tools();
    if (change === 'selection') ui.select('other'); else ui.leave();
    const before = ui.state(); reply('okd:tools:status', { release: '5.0.0-okd-scos.1', state: 'ready', generationReady: true, tools: {} });
    expect(ui.state()).toEqual(before); expect(timers.size).toBe(0);
    expect(requests.some((r) => r.event === 'okd:jobs:status')).toBe(false);
  });

  it('stops polling on transport errors and bounds a preparation polling session', () => {
    const { ui, requests, reply, timers } = okdHarness(); ui.render(); ui.tools(300);
    reply('okd:tools:status', { release: '5.0.0-okd-scos.1', state: 'preparing', tools: {} });
    expect(timers.size).toBe(0); expect(ui.state().toolsError).toContain('still running');
    ui.tools(); requests.find((r) => r.event === 'okd:tools:status').callback({ ok: false });
    expect(timers.size).toBe(0); expect(ui.state().toolsError).toContain('Unable to load');
  });

  it('waits for Bootstrap cleanup before navigation removes the editor DOM', () => {
    const handlers = {}; let visible = true; let secret = 'DUMMY-unsent';
    const render = vi.fn(); const hide = vi.fn();
    const modal = { length: 1, filter: () => ({ ...modal, length: visible ? 1 : 0 }),
      one: (event, callback) => { handlers[event] = callback; return modal; }, modal: hide };
    hide.mockReturnValue(modal);
    const $ = (selector) => selector.includes('input') ? { val: (value) => { secret = value; } } : modal;
    const source = view.slice(view.indexOf('function navTo('), view.indexOf('//// Theme Management'));
    const navigate = new Function('$', 'window', 'setActiveNav', 'vmDisposeVnc', `let okdViewEpoch=0, okdPageActive=true, okdJobPoll=null, okdModalOpen=true; function okdStopToolPoll() {} ${source}; return navTo;`)($, { renderwol: render }, () => {}, () => {});
    navigate('renderwol', 'navwol');
    expect(secret).toBe(''); expect(render).not.toHaveBeenCalled(); expect(hide).toHaveBeenCalledWith('hide');
    visible = false; handlers['hidden.bs.modal']();
    expect(render).toHaveBeenCalledOnce();
  });

  it('labels the public default without filling the input and allows a custom override', () => {
    const { $, ui, reply, refreshReplies } = okdHarness(); ui.render();
    expect($('#okd-pull-secret-status').textValue).toBe('Default OKD placeholder — public registries only; no private registry authentication');
    expect($('#okd-pull-secret-input').val()).toBe('');
    expect($('#okd-pull-secret-save').textValue).toBe('Add pull secret');
    expect($('#okd-pull-secret-save').disabled).toBe(false);
    $('#okd-pull-secret-input').val('custom test credential');
    $('#okd-pull-secret-save').handlers.click();
    reply('okd:pull-secret:save', { status: 'ready', source: 'internal', exists: true, writable: true }); refreshReplies(true);
    expect($('#okd-pull-secret-input').val()).toBe('');
    expect($('#okd-pull-secret-save').textValue).toBe('Update pull secret');
    expect($('#okd-pull-secret-status').textValue).toContain('Source: internal');
  });
  it('keeps the unchanged form clean after host fitting and a YAML save', () => {
    const { $, ui, reply, requests } = okdHarness(); ui.render();
    $('#okd-edit').handlers.click();
    reply('okd:configs:get', { installConfig: 'install YAML', agentConfig: 'agent YAML' });
    $('#okd-save-configs').handlers.click();
    reply('okd:configs:save', { revision: 'yaml-saved', installConfig: 'install YAML', agentConfig: 'agent YAML' });
    expect(ui.state().baseline).toBe(JSON.stringify(ui.state().draft));
    $('#okd-edit').handlers.click();
    expect(requests.filter((request) => request.event === 'okd:configs:get')).toHaveLength(1);
  });
  it('loads YAML even when the reply precedes the modal opening animation', () => {
    const { $, ui, reply } = okdHarness(); ui.render();
    const renders = $('#pagecontent').renders;
    $('#okd-edit').handlers.click();
    expect($('#okd-edit-modal').shown).toBe(false);
    reply('okd:configs:get', { installConfig: 'install YAML', agentConfig: 'agent YAML' });
    expect($('#okd-install-config').val()).toBe('install YAML');
    expect($('#okd-agent-config').val()).toBe('agent YAML');
    expect($('#okd-save-configs').disabled).toBe(false);
    expect($('#pagecontent').renders).toBe(renders);
  });

  it('ends YAML loading with a visible failure on acknowledgement timeout', () => {
    vi.useFakeTimers(); const { $, ui } = okdHarness(); ui.render();
    $('#okd-edit').handlers.click();
    vi.advanceTimersByTime(15000);
    expect($('#okd-config-status').textValue).toContain('not acknowledged');
    expect($('#okd-save-configs').disabled).toBe(true);
    expect($('#okd-install-config').val()).toBe('');
  });

  it('ignores YAML replies after closing the editor', () => {
    const { $, ui, reply } = okdHarness(); ui.render(); $('#okd-edit').handlers.click();
    $('#okd-edit-modal').handlers['hide.bs.modal']();
    reply('okd:configs:get', { installConfig: 'late install', agentConfig: 'late agent' });
    expect($('#okd-install-config').val()).not.toBe('late install');
    expect($('#okd-save-configs').disabled).toBe(true);
  });

   it('opens pull-secret management in the third Edit tab and clears input on close', () => {
    const { $, ui, requests } = okdHarness(); ui.render();
    $('#okd-edit').handlers.click();
    expect(requests.some((request) => request.event === 'okd:pull-secret:status')).toBe(true);
    $('#okd-pull-secret-input').val('private draft');
    $('#okd-edit-modal').handlers['hide.bs.modal']();
    expect($('#okd-pull-secret-input').val()).toBe('');
    expect(view).not.toContain('id="okd-pull-secret-open"');
    expect(view).not.toContain('id="okd-pull-secret-modal"');
    expect(view).toContain('id="okd-pull-secret-tab" data-toggle="tab" href="#okd-pull-secret-pane" role="tab" aria-controls="okd-pull-secret-pane" aria-selected="false">Pull Secret</a>');
    expect(view).toContain('id="okd-pull-secret-pane" role="tabpanel" aria-labelledby="okd-pull-secret-tab"');
    expect(view).toContain('${okdPullSecretBox()}</div>');
  });
  it('saves shared credentials without closing Edit or overwriting YAML drafts, even when YAML loading fails', () => {
    const { $, ui, requests, reply, refreshReplies } = okdHarness(); ui.render();
    $('#okd-edit').handlers.click();
    $('[id^="okd-"][id$="-modal"]').handlers['show.bs.modal']();
    requests.find((request) => request.event === 'okd:configs:get').callback({ ok: false, message: 'YAML unavailable' });
    reply('okd:pull-secret:status', { status: 'ready', source: 'default', writable: true });
    expect($('#okd-save-configs').disabled).toBe(true);
    $('#okd-install-config').val('unsaved install'); $('#okd-agent-config').val('unsaved agent');
    const renders = $('#pagecontent').renders;
    $('#okd-pull-secret-input').val('DUMMY-only'); $('#okd-pull-secret-save').handlers.click();
    reply('okd:pull-secret:save', { status: 'ready', source: 'internal', exists: true, writable: true }); refreshReplies(true);
    expect($('#pagecontent').renders).toBe(renders);
    expect($('#okd-install-config').val()).toBe('unsaved install'); expect($('#okd-agent-config').val()).toBe('unsaved agent');
    expect($('#okd-config-status').textValue).toBe('YAML unavailable');
    expect($('#okd-pull-secret-status').textValue).toContain('Source: internal');
  });
  it('allows secret setup for an unsaved form without saving or loading YAML', () => {
    const { $, ui, requests } = okdHarness(); ui.render(); ui.dirty();
    $('#okd-edit').handlers.click();
    expect($('#okd-config-status').textValue).toContain('Save the profile first');
    expect($('#okd-save-configs').disabled).toBe(true);
    expect(requests.map((r) => r.event)).toEqual(['okd:pull-secret:status', 'okd:tools:status']);
  });
  it('keeps typed profile/YAML/secret and modal DOM through background polling, then enables Generate after secret save', () => {
    const { $, ui, reply, refreshReplies } = okdHarness();
    ui.render(); const renders = $('#pagecontent').renders;
    $('#okd-edit-modal').shown = true;
    $('[id^="okd-"][id$="-modal"]').handlers['show.bs.modal']();
    $('#okd-install-config').val('typed YAML'); $('#okd-pull-secret-input').val('typed secret');
    ui.tools();
    reply('okd:tools:status', { state: 'ready', release: '5.0.0-okd-scos.1', generationReady: true, tools: {} });
    refreshReplies(false);
    expect($('#pagecontent').renders).toBe(renders); expect($('#okd-edit-modal').shown).toBe(true);
    expect($('#okd-install-config').val()).toBe('typed YAML'); expect($('#okd-pull-secret-input').val()).toBe('typed secret');
    $('#okd-edit-modal').shown = false;
    ui.render(); expect($('#pagecontent').renders).toBe(renders); // hide transition, before hidden
    $('[id^="okd-"][id$="-modal"]').handlers['hidden.bs.modal'].call($('#okd-edit-modal'));
    $('#okd-pull-secret-save').handlers.click(); expect($('#okd-pull-secret-input').val()).toBe('');
    reply('okd:pull-secret:save', { status: 'ready', source: 'internal', writable: true }); refreshReplies(true);
    expect($('#okd-generate').disabled).toBe(false);
    ui.dirty(); $('#okd-pull-secret-input').val('second draft'); ui.refresh(); refreshReplies(true);
    expect(ui.state().draft.cluster_name).toBe('unsaved'); expect($('#okd-pull-secret-input').val()).toBe('second draft');
    expect($('#okd-generate').disabled).toBe(true); expect($('#pagecontent').renders).toBe(renders);
    $('[data-okd-tab]').handlers.click.call($('[data-okd-tab]'));
    expect($('#okd-pull-secret-input').val()).toBe('');
    $('#okd-monitor-log').handlers.click(); const beforeLeave = $('#pagecontent').renders; ui.leave();
    reply('okd:operations:monitor:log', { text: 'late result' });
    expect($('#pagecontent').renders).toBe(beforeLeave);
  });

  it.each(['selection', 'page'])('ignores Save A responses after a newer %s context', (change) => {
    const { ui, reply, requests } = okdHarness(); ui.render(); ui.save();
    const saved = { ...requests.find((item) => item.event === 'okd:save').payload.profile, revision: 'saved' };
    if (change === 'selection') ui.select('profile-b'); else ui.leave();
    const before = ui.state(); reply('okd:save', saved);
    expect(ui.state()).toEqual(before); expect(requests.some((item) => item.event === 'okd:list')).toBe(false);
  });

  it('keeps edits after submission/ack while updating saved revision, and guards the nested list reply', () => {
    const { ui, reply, requests } = okdHarness(); ui.render(); ui.save();
    const saved = { ...requests.find((item) => item.event === 'okd:save').payload.profile, revision: 'saved' };
    ui.dirty(); reply('okd:save', saved);
    expect(ui.state()).toMatchObject({ revision: 'saved', profile: { cluster_name: 'unsaved', revision: 'saved' } });
    expect(ui.state().baseline).not.toBe(JSON.stringify(ui.state().draft));
    ui.select('profile-b'); const before = ui.state(); reply('okd:list', [saved]);
    expect(ui.state()).toEqual(before);
    expect(requests.some((item) => item.event === 'okd:jobs:status')).toBe(false);
  });

  it('preserves typing while the post-Save list acknowledgement is pending', () => {
    const { ui, reply, requests } = okdHarness(); ui.render(); ui.save();
    const saved = { ...requests.find((item) => item.event === 'okd:save').payload.profile, revision: 'saved' };
    reply('okd:save', saved); ui.dirty(); reply('okd:list', [saved]);
    expect(ui.state()).toMatchObject({ revision: 'saved', profile: { cluster_name: 'unsaved' } });
    expect(ui.state().baseline).not.toBe(JSON.stringify(ui.state().draft));
  });

  it.each(['timeout', 'disconnect', 'offline'])('resets pull-secret saving after %s without replaying or restoring credentials', (failure) => {
    vi.useFakeTimers(); const { $, ui, socket, requests, reply } = okdHarness(); ui.render();
    $('#okd-pull-secret-input').val('dummy-private-value');
    if (failure === 'offline') socket.connected = false;
    $('#okd-pull-secret-save').handlers.click();
    if (failure === 'timeout') vi.advanceTimersByTime(30000);
    if (failure === 'disconnect') socket.disconnect();
    expect(ui.state().secretSaving).toBe(false);
    expect(ui.state().secretMessage).toContain('not acknowledged');
    expect(ui.state().secretMessage).not.toContain('dummy-private-value');
    expect($('#okd-pull-secret-input').val()).toBe('');
    expect($('#okd-pull-secret-save').disabled).toBe(false);
    expect(requests.filter((item) => item.event === 'okd:pull-secret:save')).toHaveLength(failure === 'offline' ? 0 : 1);
    if (failure !== 'offline') { reply('okd:pull-secret:save', { status: 'ready' }); expect(ui.state().secretMessage).toContain('not acknowledged'); }
  });
  it('adds a top-level navTo item and render function using only the fixed release', () => {
    expect(index).toContain("navTo('renderokd','navokd')");
    expect(index).toContain('>OKD</div>');
    expect(view).toContain('function renderokd()');
    expect(view).toContain("const OKD_RELEASE = '5.0.0-okd-scos.1'");
    expect(view).not.toMatch(/OKD_RELEASE.*latest/);
    expect(view).toContain("socket.emit('okd:save'");
    expect(view).toContain('expectedRevision: okdRevision');
    expect(view).toContain("'\"': '&quot;'");
    expect(view).toContain('"\'": \'&#39;\'');
    expect(view).toContain('okdAttr(host.role)');
    expect(view).toContain('${okdAttr(p.ssh_public_key)}');
    expect(view).toContain('Discard unsaved OKD profile changes?');
    expect(view).toContain('This change removes populated host rows. Continue?');
    expect(view).toContain('function okdDiskHintParts(hint)');
    expect(view).toContain("{ type: 'deviceName', value: '' }");
    expect(view).toContain('data-host="disk_hint_type"');
    expect(view).toContain('data-host="disk_hint_value"');
    expect(view).toContain("+ ':' + diskHintValue");
    expect(view).toContain('>Hint type</th><th>Hint value</th>');
    expect(view).toContain("type === 'wwn' ? '0x5000c500aabbccdd'");
    expect(view).toContain("type === 'serial' ? 'ABC-123' : '/dev/vda'");
    expect(view).toContain('enter <code>/dev/sda</code>, not <code>deviceName:/dev/sda</code>');
    expect(view).toContain('Enter a root-device hint value only');
    expect(view).toContain("socket.timeout(15000).emit('okd:tools:status', release");
    expect(view).not.toContain("emit('okd:tools:install'");
    expect(view).toContain("socket.timeout(15000).emit('okd:configs:get'");
    expect(view).toContain("socket.emit('okd:configs:save'");
    expect(view).toContain("if (forceToast || okdActiveTab !== 'profiles' || !box.length)");
    expect(view).toContain("okdShowResult(result, true); return;");
    expect(view).toContain("okdAfterModalHidden('#okd-edit-modal', okdRefreshJobs)");
    expect(view).toContain("okdAfterModalHidden('#okd-generate-modal', okdRefreshJobs)");
    expect(view).toContain('id="okd-tools-progress"');
    expect(view).toContain('progress-bar-striped progress-bar-animated');
    expect(view).toContain('function okdUpdateToolsModal()');
    expect(view).not.toContain("okdRerenderModal('#okd-tools-modal')");
    expect(view).toContain('id="okd-pull-secret-input"');
    expect(view).toContain('id="okd-pull-secret-save"');
    expect(view).toContain('id="okd-pull-secret-loading"');
    expect(view).toContain("socket.emit('okd:pull-secret:status', {}");
    expect(view).toContain("socket.volatile.timeout(30000).emit('okd:pull-secret:save', { secret: secret }");
    expect(view).toContain("input.val('');");
    const pullSecretSave = view.slice(view.indexOf("$('#okd-pull-secret-save').click"), view.indexOf("$('#okd-edit').click"));
    expect(pullSecretSave).toContain('okdSubmitPullSecret(secret)');
    expect(pullSecretSave).not.toContain('okdRenderForm()');
    expect(pullSecretSave).not.toContain(".modal('hide')");
    expect(view).not.toContain("socket.emit('okd:tools:prepare'");
    expect(view).toContain('data-okd-tab="profiles"');
    expect(view).toContain('data-okd-tab="artifacts"');
    expect(view).toContain('data-okd-tab="operations"');
    expect(view).not.toContain('data-okd-tab="tools"');
    expect(view).toContain('id="okd-content-card" class="card mb-3"');
    expect(view).toContain('id="okd-content-body" class="card-body py-3"');
    expect(view).not.toContain('id="okd-tools-modal"');
    expect(view).not.toContain('id="okd-tools"');
    expect(view).toContain('id="okd-tools-tab"');
    expect(view).toContain('id="okd-edit-modal"');
    expect(view).toContain('id="okd-install-config-tab" data-toggle="tab"');
    expect(view).toContain('href="#okd-install-config-pane"');
    expect(view).toContain('id="okd-agent-config-tab" data-toggle="tab"');
    expect(view).toContain('href="#okd-agent-config-pane"');
    expect(view).toContain('id="okd-generate-modal"');
    expect(view).toContain('aria-modal="true"');
    expect(view.match(/<strong>Profiles<\/strong>/g)).toHaveLength(1);
    expect(view).not.toContain('<strong>OKD Profiles</strong>');
    expect(view).toContain('data-okd-generate="pxe"');
    expect(view).toContain('>PXE boot</button>');
    expect(view).toContain('data-okd-generate="iso"');
    expect(view).toContain('>ISO</button>');
    expect(view).toContain('Disk-destructive warning:');
    expect(view).toContain("${okdExistingId ? okdJobCard(p) + okdOperationsCard()");
    expect(view).toContain("${okdVersionCard() || '<div class=\"text-muted\">Select a saved profile.</div>'}");
    expect(view).not.toContain('OKD ${OKD_RELEASE} tools');
    expect(view).not.toContain('<option value="4.22.0-okd-scos.9"');
    expect(view).toContain('<option value="${OKD_RELEASE}"');
    expect(view).not.toContain('okdToolRelease');
    expect(view).not.toContain('id="okd-install-tools"');
    expect(view).not.toContain('Prepare ${label}');
    expect(view).toContain("okdToolCard('installer', 'openshift-install')");
    expect(view).toContain("okdToolCard('oc', 'oc')");
    expect(view).toContain('Server binary: <code>');
    expect(view).toContain('Source URL: <code>');
    expect(view).toContain('Binaries stay on the server.');
    expect(view).toContain("socket.emit('okd:jobs:preflight'");
    expect(view).toContain("socket.emit('okd:jobs:start'");
    expect(view).toContain("socket.emit('okd:jobs:cancel'");
    expect(view).toContain("socket.emit('okd:jobs:log'");
    expect(view).toContain("socket.emit('okd:versions:list'");
    expect(view).toContain("socket.emit('okd:versions:publish'");
    expect(view).toContain("socket.emit('okd:versions:unpublish'");
    expect(view).toContain("socket.emit('okd:versions:delete'");
    expect(view).toContain('HTTPS ISO');
    expect(view).toContain('data-okd-delete-version');
    expect(view).toContain('data-okd-uefi-test');
    expect(view).toContain('Open managed UEFI boot test');
    expect(view).toContain("navTo('renderconsole', 'navconsole')");
    expect(view).toContain('vmCreate();');
    expect(view).toContain('does not prove BIOS, Agent rootfs trust, inventory, or target disk acceptance');
    expect(view).toContain('Save or discard profile changes before generation.');
    expect(view).toContain('confirmed: true, mode: mode');
    expect(view).toContain('const requestProfile = okdExistingId; const requestRevision = okdRevision;');
    expect(view).toContain('requestProfile !== okdExistingId || requestRevision !== okdRevision');
    expect(view).toContain("socket.emit('okd:jobs:preflight', { profileId: requestProfile, revision: requestRevision }");
    expect(view).toContain('It does not stop booted machines or roll back a cluster.');
    expect(view).toContain('<strong>Operations</strong>');
    expect(view).toContain('Start monitoring');
    expect(view).toContain('Cancel monitoring');
    expect(view).toContain('Cluster health snapshot');
    expect(view).toContain('Run probes');
    expect(view).toContain('Storage / retention report');
    expect(view).toContain('Clean eligible private data');
    expect(view).toContain('Diagnostics');
    expect(view).toContain("socket.emit('okd:operations:monitor:start'");
    expect(view).toContain("socket.emit('okd:operations:monitor:cancel'");
    expect(view).toContain('Cancel active installer monitoring?');
    expect(view).toContain('Cancel active Agent generation?');
    expect(view).toContain("socket.emit('okd:delete', { id: okdExistingId, confirmed: true }");
    expect(view).toContain("socket.emit('okd:operations:health'");
    expect(view).toContain("socket.emit('okd:operations:probes'");
    expect(view).toContain("socket.emit('okd:operations:cleanup'");
    expect(view).toContain('endpoints are derived server-side');
    expect(view).toContain('No workspace path, kubeconfig, credential, raw installer state, or raw cluster JSON is returned.');
    expect(() => new Function(view.replaceAll('<%= baseurl %>', '/'))).not.toThrow();

    expect(view).not.toContain('id="okd-tool-release"');
  });

  it('parses stored disk hints and defaults empty rows without inventing a value', () => {
    const source = view.slice(view.indexOf('function okdDiskHintParts'), view.indexOf('function okdSnapshot'));
    const helpers = new Function(`${source}; return { okdDiskHintParts, okdDiskHintPlaceholder };`)();

    expect(helpers.okdDiskHintParts('wwn:0x123')).toEqual({ type: 'wwn', value: '0x123' });
    expect(helpers.okdDiskHintParts('serial:ABC-123')).toEqual({ type: 'serial', value: 'ABC-123' });
    expect(helpers.okdDiskHintParts('deviceName:/dev/vda')).toEqual({ type: 'deviceName', value: '/dev/vda' });
    expect(helpers.okdDiskHintParts('')).toEqual({ type: 'deviceName', value: '' });
    expect(['wwn', 'serial', 'deviceName'].map(helpers.okdDiskHintPlaceholder)).toEqual(['0x5000c500aabbccdd', 'ABC-123', '/dev/vda']);
  });

  it('keeps generation status in Operations while confirmation actions stay in the modal', () => {
    const source = view.slice(view.indexOf('function okdJobCard'), view.indexOf('function okdRenderForm'));

    expect(source).toContain('id="okd-job-state" aria-live="polite"');
    expect(source).toContain('Created: ${okdAttr(shown.createdAt');
    expect(source).toContain('id="okd-generate-reason"');
    expect(source).toContain('id="okd-cancel"');
    expect(source).toContain('current && current.cancellable');
    expect(source).toContain('Global generation job');
    expect(source).toContain('okdJobStatus.blocking');
    expect(source).toContain('id="okd-log"');
    expect(source).toContain('View sanitized log');
    expect(source).toContain('${okdAttr(okdJobLog)}');
    expect(source).not.toContain('data-okd-generate=');
  });

  it('prefills new profiles with a valid SNO platform-none example', () => {
    const source = view.slice(view.indexOf('function okdNewProfile'), view.indexOf('function okdDesiredRoles'));
    const profile = new Function(`const OKD_RELEASE = '5.0.0-okd-scos.1'; ${source}; return okdNewProfile();`)();

    expect(profile).toEqual({
      id: 'lab-okd', release: '5.0.0-okd-scos.1', platform: 'none', topology: 'sno',
      cluster_name: 'lab', base_domain: 'example.com', machine_network: '192.168.7.0/24', rendezvous_ip: '192.168.7.10',
      ssh_public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey', worker_count: 0, api_vip: '', ingress_vip: '',
      hosts: [{ hostname: 'master-0', role: 'control-plane', mac: '02:00:00:00:00:10', ipv4: '192.168.7.10', interface: 'eno1', disk_hint: 'deviceName:/dev/vda' }],
    });
  });

  it('restores an existing profile and keeps Edit clickable with request feedback', () => {
    const selectorSource = view.slice(view.indexOf('function okdListedProfileId'), view.indexOf('function okdConfirmDiscard'));
    const select = new Function(`${selectorSource}; return okdListedProfileId;`)();
    expect(select([{ id: 'first' }, { id: 'selected' }], 'selected')).toBe('selected');
    expect(select([{ id: 'first' }], 'missing')).toBe('first');
    expect(select([], 'missing')).toBeNull();

    const renderSource = view.slice(view.indexOf('function renderokd()'), view.indexOf('//// Render WOL page'));
    expect(renderSource).toContain("socket.emit('okd:get', selectedId");
    expect(renderSource).toContain('okdExistingId = profileResult.data.id; okdRevision = profileResult.data.revision');
    const editButton = view.match(/<button id="okd-edit"[^>]*>/)[0];
    expect(editButton).not.toContain('disabled');
    const editSource = view.slice(view.indexOf("$('#okd-edit').click"), view.indexOf("$('#okd-save-configs').click"));
    expect(editSource).toContain("okdConfigStatus = 'Loading YAML templates…'");
    expect(editSource).toContain("$('#okd-edit-modal').modal('show');");
    expect(editSource).toContain('requestId !== okdExistingId || requestRevision !== okdRevision');
    expect(editSource).toContain('okdShowResult(result, true)');
  });
});
