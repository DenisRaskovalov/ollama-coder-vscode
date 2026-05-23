import * as vscode from "vscode";
import { chat, ChatMessage } from "./ollama";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ollamaCoder.chatView";

  private view: vscode.WebviewView | undefined;
  private history: ChatMessage[] = [];
  private inflight: AbortController | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "send":
          await this.handleSend(String(msg.text ?? ""), !!msg.includeFile);
          break;
        case "stop":
          this.inflight?.abort();
          break;
        case "clear":
          this.history = [];
          this.post({ type: "cleared" });
          break;
      }
    });
  }

  reveal() {
    this.view?.show?.(true);
  }

  private post(m: unknown) {
    this.view?.webview.postMessage(m);
  }

  private async handleSend(text: string, includeFile: boolean) {
    if (!text.trim()) return;
    this.inflight?.abort();

    const cfg = vscode.workspace.getConfiguration("ollamaCoder");
    const endpoint = cfg.get<string>("endpoint", "http://localhost:11434");
    const model = cfg.get<string>("chatModel", "llama3.1:8b-instruct");
    const temperature = cfg.get<number>("temperature", 0.3);
    const ctxChars = cfg.get<number>("contextWindowChars", 4000);

    let userContent = text;
    const ed = vscode.window.activeTextEditor;
    if (includeFile && ed) {
      const doc = ed.document;
      const sel = ed.selection;
      const lang = doc.languageId;
      if (!sel.isEmpty) {
        const code = doc.getText(sel).slice(0, ctxChars);
        userContent = `${text}\n\nSelected code (${lang}, ${doc.fileName}):\n\`\`\`${lang}\n${code}\n\`\`\``;
      } else {
        const code = doc.getText().slice(0, ctxChars);
        userContent = `${text}\n\nCurrent file (${lang}, ${doc.fileName}):\n\`\`\`${lang}\n${code}\n\`\`\``;
      }
    }

    if (this.history.length === 0) {
      this.history.push({
        role: "system",
        content:
          "You are Ollama Coder, an expert pair-programmer running locally. " +
          "Answer concisely. Use fenced code blocks for code.",
      });
    }
    this.history.push({ role: "user", content: userContent });

    this.post({ type: "userMessage", text });
    this.post({ type: "assistantStart" });

    const ctrl = new AbortController();
    this.inflight = ctrl;
    let full = "";
    try {
      full = await chat(
        {
          endpoint,
          model,
          messages: this.history,
          temperature,
          numPredict: 2048,
          signal: ctrl.signal,
        },
        (tok) => this.post({ type: "assistantToken", text: tok })
      );
      this.history.push({ role: "assistant", content: full });
      this.post({ type: "assistantEnd" });
    } catch (e: any) {
      const aborted = String(e?.message).includes("aborted");
      this.post({
        type: "assistantError",
        text: aborted ? "(stopped)" : `Error: ${e?.message ?? e}`,
      });
    }
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-sideBar-background); margin: 0; padding: 0;
         display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 8px; font-size: 13px; }
  .msg { margin-bottom: 12px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { color: var(--vscode-textLink-foreground); }
  .msg.assistant { color: var(--vscode-foreground); }
  .role { font-weight: bold; font-size: 11px; text-transform: uppercase;
          opacity: 0.7; margin-bottom: 2px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px;
        border-radius: 4px; overflow-x: auto; }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  #bar { border-top: 1px solid var(--vscode-panel-border); padding: 6px;
         display: flex; flex-direction: column; gap: 4px; }
  #input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 56px;
           background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--vscode-input-border, transparent); padding: 6px;
           font-family: var(--vscode-font-family); font-size: 13px; }
  #row { display: flex; gap: 6px; align-items: center; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: 0; padding: 4px 10px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }
  label { font-size: 12px; opacity: 0.85; }
</style>
</head>
<body>
  <div id="log"></div>
  <div id="bar">
    <textarea id="input" placeholder="Ask anything. Ctrl/Cmd+Enter to send."></textarea>
    <div id="row">
      <label><input type="checkbox" id="ctx" checked /> include current file/selection</label>
      <span style="flex:1"></span>
      <button id="stop" class="secondary">Stop</button>
      <button id="clear" class="secondary">Clear</button>
      <button id="send">Send</button>
    </div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  let current = null;
  let currentRaw = "";

  function escapeHtml(s){return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
  function render(raw){
    // Very small markdown: fenced code blocks only
    return escapeHtml(raw).replace(/\`\`\`([a-zA-Z0-9_+-]*)\\n([\\s\\S]*?)\`\`\`/g,
      (_,l,c)=>'<pre><code>'+c+'</code></pre>');
  }
  function addMsg(role, text){
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.innerHTML = '<div class="role">'+role+'</div><div class="body">'+render(text)+'</div>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d.querySelector('.body');
  }
  function send(){
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    vscode.postMessage({ type:'send', text, includeFile: document.getElementById('ctx').checked });
  }
  document.getElementById('send').onclick = send;
  document.getElementById('stop').onclick = ()=>vscode.postMessage({type:'stop'});
  document.getElementById('clear').onclick = ()=>{ log.innerHTML=''; vscode.postMessage({type:'clear'}); };
  input.addEventListener('keydown', (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key === 'Enter'){ e.preventDefault(); send(); }
  });
  window.addEventListener('message', (e)=>{
    const m = e.data;
    if (m.type === 'userMessage') addMsg('user', m.text);
    else if (m.type === 'assistantStart'){ currentRaw=''; current = addMsg('assistant',''); }
    else if (m.type === 'assistantToken'){ currentRaw += m.text; if(current) current.innerHTML = render(currentRaw); log.scrollTop = log.scrollHeight; }
    else if (m.type === 'assistantEnd'){ current = null; }
    else if (m.type === 'assistantError'){ if(current) current.textContent = m.text; current = null; }
    else if (m.type === 'cleared'){ log.innerHTML=''; }
  });
</script>
</body></html>`;
  }
}
