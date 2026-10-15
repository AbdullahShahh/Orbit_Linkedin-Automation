const $ = (id) => document.getElementById(id);
let port = 4000;

function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (s) => {
    if (!s) return;
    port = s.port;
    $('port').value = s.port;
    $('conn').textContent = s.connected ? 'Connected' : 'Not connected';
    $('conn').className = s.connected ? 'ok' : 'bad';
    $('tab').textContent = s.workTab ? s.workTab.title : 'auto (active LinkedIn tab)';
    $('tab').title = s.workTab ? s.workTab.url : '';
    $('err').textContent = s.connected ? '' : s.lastError || 'Start the dashboard server (start.command)';
  });
}

$('open').onclick = () => chrome.tabs.create({ url: `http://localhost:${port}` });
$('use').onclick = () =>
  chrome.runtime.sendMessage({ type: 'useThisTab' }, (r) => {
    $('err').textContent = r && r.error ? r.error : '';
    refresh();
  });
$('save').onclick = () => chrome.runtime.sendMessage({ type: 'setPort', port: $('port').value }, () => setTimeout(refresh, 800));

chrome.runtime.sendMessage({ type: 'reconnect' }, () => setTimeout(refresh, 600));
refresh();

$('ver').textContent = 'v' + chrome.runtime.getManifest().version;
