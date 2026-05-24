" ============================================================================
" ollama_coder autoload - HTTP client, chat buffer, code actions, agent loop.
" ============================================================================

" Vim line-continuation ('\') is sensitive to 'cpoptions'. Save and reset to
" the default so this file parses correctly under non-standard cpo settings
" (and under -u NONE, which is what our tests use).
let s:save_cpo = &cpoptions
set cpoptions&vim

let s:active_job  = v:null
let s:line_buf    = ''
let s:full_text   = ''
let s:tool_calls  = []
let s:on_token    = v:null
let s:on_done     = v:null

function! s:handle_chunk(text) abort
  let s:line_buf .= a:text
  while 1
    let nl = stridx(s:line_buf, "\n")
    if nl < 0 | break | endif
    let line = s:line_buf[0 : nl-1]
    let s:line_buf = s:line_buf[nl+1 :]
    if empty(trim(line)) | continue | endif
    try
      let j = json_decode(line)
    catch
      continue
    endtry
    if type(j) != type({}) | continue | endif
    let msg = get(j, 'message', {})
    let tok = get(msg, 'content', '')
    if !empty(tok)
      let s:full_text .= tok
      if s:on_token isnot v:null
        call call(s:on_token, [tok])
      endif
    endif
    let tcs = get(msg, 'tool_calls', [])
    if !empty(tcs)
      call extend(s:tool_calls, tcs)
    endif
  endwhile
endfunction

function! s:nvim_on_stdout(_id, data, _ev) abort
  " data is a list of lines; the last entry is a partial fragment.
  call s:handle_chunk(join(a:data, "\n"))
endfunction
function! s:vim_out_cb(_ch, data) abort
  call s:handle_chunk(a:data . "\n")
endfunction

function! s:nvim_on_exit(_id, code, _ev) abort
  call s:finish(a:code)
endfunction
function! s:vim_exit_cb(_job, code) abort
  call s:finish(a:code)
endfunction

function! s:finish(code) abort
  " Flush any trailing line that didn't end with LF.
  if !empty(trim(s:line_buf))
    call s:handle_chunk("\n")
  endif
  if s:on_done isnot v:null
    call call(s:on_done, [s:full_text, s:tool_calls, a:code])
  endif
  let s:active_job = v:null
endfunction

function! ollama_coder#stop() abort
  if s:active_job isnot v:null
    if has('nvim')
      try | call jobstop(s:active_job) | catch | endtry
    else
      try | call job_stop(s:active_job) | catch | endtry
    endif
    let s:active_job = v:null
  endif
endfunction

" Public: stream a /api/chat request.
" body = dict to POST (model, messages, tools?, stream:true/false)
" Token callback fires per assistant content chunk.
" Done callback gets (full_text, tool_calls_list, exit_code).
function! ollama_coder#stream_chat(body, OnToken, OnDone) abort
  call ollama_coder#stop()
  let s:line_buf   = ''
  let s:full_text  = ''
  let s:tool_calls = []
  let s:on_token   = a:OnToken
  let s:on_done    = a:OnDone

  let l:url = g:ollama_coder_endpoint . '/api/chat'
  let l:json = json_encode(a:body)

  " We feed the body via stdin to avoid argv-size limits on big prompts.
  let l:cmd = ['curl', '-sS', '-N', '-X', 'POST',
        \ '-H', 'Content-Type: application/json',
        \ '--data-binary', '@-', l:url]

  if has('nvim')
    let s:active_job = jobstart(l:cmd, {
          \ 'on_stdout': function('s:nvim_on_stdout'),
          \ 'on_exit':   function('s:nvim_on_exit'),
          \ 'stdout_buffered': v:false,
          \ })
    if s:active_job > 0
      call chansend(s:active_job, l:json)
      call chanclose(s:active_job, 'stdin')
    endif
  else
    let s:active_job = job_start(l:cmd, {
          \ 'out_cb':   function('s:vim_out_cb'),
          \ 'exit_cb':  function('s:vim_exit_cb'),
          \ 'in_io':    'pipe',
          \ 'out_mode': 'raw',
          \ })
    let l:ch = job_getchannel(s:active_job)
    call ch_sendraw(l:ch, l:json)
    call ch_close_in(l:ch)
  endif
endfunction

" ---------------- /api/tags model list (sync) ----------------

function! ollama_coder#list_models() abort
  let l:url = g:ollama_coder_endpoint . '/api/tags'
  let l:out = system('curl -sf -m 15 -H "Accept: application/json" ' . shellescape(l:url))
  if v:shell_error != 0 | return [] | endif
  try
    let l:j = json_decode(l:out)
  catch
    return []
  endtry
  let l:arr = get(l:j, 'models', [])
  if type(l:arr) != type([]) | return [] | endif
  let l:names = []
  let l:seen  = {}
  for l:m in l:arr
    let l:n = ''
    if type(l:m) == type('')
      let l:n = l:m
    elseif type(l:m) == type({})
      let l:n = get(l:m, 'name', get(l:m, 'model', ''))
    endif
    if !empty(l:n) && !has_key(l:seen, l:n)
      let l:seen[l:n] = 1
      call add(l:names, l:n)
    endif
  endfor
  return sort(l:names)
endfunction

function! ollama_coder#pick_model() abort
  let l:models = ollama_coder#list_models()
  if empty(l:models)
    echohl WarningMsg
    echom 'ollama-coder: no models found at ' . g:ollama_coder_endpoint
          \ . '. Run: ollama pull llama3.1:8b'
    echohl None
    return
  endif
  let l:choices = ['Pick chat model:']
  let l:i = 1
  for l:m in l:models
    call add(l:choices, printf('%d. %s%s',
          \ l:i, l:m,
          \ (l:m ==# g:ollama_coder_chat_model ? '  (current)' : '')))
    let l:i += 1
  endfor
  call inputsave()
  let l:pick = inputlist(l:choices)
  call inputrestore()
  if l:pick > 0 && l:pick <= len(l:models)
    let g:ollama_coder_chat_model = l:models[l:pick - 1]
    echom 'ollama-coder: chat model -> ' . g:ollama_coder_chat_model
  endif
endfunction

" ---------------- chat buffer ----------------

let s:chat_bufnr = -1
let s:chat_messages = []      " full conversation incl. system
let s:chat_writing_assistant = 0
let s:chat_history = []       " user prompts only, newest first (in-memory)
let s:HISTORY_FILE = expand('~/.cache/ollama-coder/history')

function! s:save_history() abort
  let l:dir = fnamemodify(s:HISTORY_FILE, ':h')
  if !isdirectory(l:dir) | call mkdir(l:dir, 'p') | endif
  call writefile(s:chat_history[0 : 99], s:HISTORY_FILE)
endfunction

function! s:load_history() abort
  if filereadable(s:HISTORY_FILE)
    let s:chat_history = readfile(s:HISTORY_FILE)
  endif
endfunction
call s:load_history()

function! s:chat_buf_ensure() abort
  if s:chat_bufnr != -1 && bufexists(s:chat_bufnr) && bufloaded(s:chat_bufnr)
    " Already exists; bring it up in a window.
    let l:win = bufwinnr(s:chat_bufnr)
    if l:win == -1
      execute 'botright vsplit | buffer ' . s:chat_bufnr
    else
      execute l:win . 'wincmd w'
    endif
    return
  endif
  botright vnew
  setlocal buftype=nofile bufhidden=hide noswapfile nobuflisted
  setlocal filetype=markdown wrap linebreak
  setlocal nomodeline
  silent file [Ollama-Coder]
  let s:chat_bufnr = bufnr('%')
  call setline(1, ['# Ollama Coder',
        \ '',
        \ 'Model: ' . g:ollama_coder_chat_model
        \ . '   Endpoint: ' . g:ollama_coder_endpoint,
        \ '',
        \ 'Commands inside this buffer:',
        \ '  :OllamaSend <prompt>   - send a message',
        \ '  :OllamaWrite <prompt>  - run an agent turn (can create/edit files)',
        \ '  :OllamaModel           - switch chat model',
        \ '  :OllamaStop            - cancel in-flight request',
        \ '  :OllamaHistory         - recall past prompt',
        \ ''])
  setlocal nomodifiable
  let s:chat_messages = []
endfunction

function! s:chat_append(lines) abort
  if s:chat_bufnr == -1 || !bufexists(s:chat_bufnr) | return | endif
  let l:winid = bufwinid(s:chat_bufnr)
  let l:was_mod = getbufvar(s:chat_bufnr, '&modifiable')
  call setbufvar(s:chat_bufnr, '&modifiable', 1)
  call appendbufline(s:chat_bufnr, '$', a:lines)
  call setbufvar(s:chat_bufnr, '&modifiable', l:was_mod)
  if l:winid != -1
    call win_execute(l:winid, 'normal! G')
  endif
endfunction

function! s:chat_append_inline(text) abort
  " Streaming token: append to last line (handling embedded newlines).
  if s:chat_bufnr == -1 || !bufexists(s:chat_bufnr) | return | endif
  let l:was_mod = getbufvar(s:chat_bufnr, '&modifiable')
  call setbufvar(s:chat_bufnr, '&modifiable', 1)
  let l:parts = split(a:text, "\n", 1)
  let l:lastline = getbufline(s:chat_bufnr, '$')[0]
  call setbufline(s:chat_bufnr, '$', l:lastline . l:parts[0])
  if len(l:parts) > 1
    call appendbufline(s:chat_bufnr, '$', l:parts[1:])
  endif
  call setbufvar(s:chat_bufnr, '&modifiable', l:was_mod)
  let l:winid = bufwinid(s:chat_bufnr)
  if l:winid != -1
    call win_execute(l:winid, 'normal! G')
  endif
endfunction

function! ollama_coder#chat_open(...) abort
  call s:chat_buf_ensure()
  if a:0 > 0 && !empty(a:1)
    call ollama_coder#chat_send(a:1)
  endif
endfunction

function! ollama_coder#chat_send(prompt) abort
  call s:chat_buf_ensure()
  if empty(s:chat_messages)
    call add(s:chat_messages, {
          \ 'role': 'system',
          \ 'content':
          \   "You are Ollama Coder, a local pair-programmer running inside Vim. "
          \ . "Be concise. Use fenced code blocks for code. "
          \ . "When code targets a file, put the path right after the language: ```ts src/foo.ts."
          \ })
  endif
  call add(s:chat_messages, {'role': 'user', 'content': a:prompt})

  " Remember in history (dedup, newest first).
  call filter(s:chat_history, 'v:val !=# a:prompt')
  call insert(s:chat_history, a:prompt, 0)
  let s:chat_history = s:chat_history[0 : 99]
  call s:save_history()

  call s:chat_append(['', '## user', a:prompt, '', '## assistant', ''])
  let s:chat_writing_assistant = 1

  call ollama_coder#stream_chat({
        \ 'model':    g:ollama_coder_chat_model,
        \ 'messages': s:chat_messages,
        \ 'stream':   v:true,
        \ 'options':  {
        \   'temperature': g:ollama_coder_temperature,
        \   'num_predict': 2048,
        \ },
        \ },
        \ function('s:chat_on_token'),
        \ function('s:chat_on_done'))
endfunction

function! s:chat_on_token(tok) abort
  call s:chat_append_inline(a:tok)
endfunction

function! s:chat_on_done(text, _tool_calls, _code) abort
  let s:chat_writing_assistant = 0
  call add(s:chat_messages, {'role': 'assistant', 'content': a:text})
  call s:chat_append([''])
endfunction

" ---------------- code actions ----------------

let s:ACTIONS = {
      \ 'explain':  { 'title': 'Explain',          'system': 'Explain code clearly. Short paragraphs and bullets.',                                                         'replace': v:false },
      \ 'refactor': { 'title': 'Refactor',         'system': 'Refactor for readability. Keep behavior. Return ONLY the new code, no fences, no commentary.',                'replace': v:true  },
      \ 'fix':      { 'title': 'Fix bugs',         'system': 'Find and fix bugs. Preserve intent. Return ONLY the fixed code, no fences, no commentary.',                   'replace': v:true  },
      \ 'docs':     { 'title': 'Add docstrings',   'system': 'Add docstrings/comments. Do not change behavior. Return ONLY the annotated code, no fences, no commentary.',  'replace': v:true  },
      \ 'tests':    { 'title': 'Generate tests',   'system': 'Write thorough unit tests in the idiomatic framework for this language. Return ONLY the test file contents.', 'replace': v:false },
      \ 'ask':      { 'title': 'Ask about code',   'system': 'Answer the user''s question about the code precisely.',                                                       'replace': v:false },
      \ }

function! s:visual_selection(line1, line2) abort
  let l:lines = getline(a:line1, a:line2)
  return [join(l:lines, "\n"), a:line1, a:line2]
endfunction

function! ollama_coder#action(name, line1, line2, extra) abort
  if !has_key(s:ACTIONS, a:name)
    echohl ErrorMsg | echom 'ollama-coder: unknown action ' . a:name | echohl None
    return
  endif
  let l:spec = s:ACTIONS[a:name]
  let [l:code, l:l1, l:l2] = s:visual_selection(a:line1, a:line2)
  if empty(trim(l:code))
    echohl WarningMsg | echom 'ollama-coder: empty selection' | echohl None
    return
  endif
  let l:lang = &filetype
  let l:q = a:extra
  if a:name ==# 'ask' && empty(l:q)
    call inputsave()
    let l:q = input('Ask about selection: ')
    call inputrestore()
    if empty(l:q) | return | endif
  endif

  let l:user =
        \ a:name ==# 'ask' ?
        \   printf("Question: %s\n\nCode (%s):\n```%s\n%s\n```", l:q, l:lang, l:lang, l:code)
        \ : a:name ==# 'explain' || a:name ==# 'tests' ?
        \   printf("Code (%s):\n```%s\n%s\n```", l:lang, l:lang, l:code)
        \ :   l:code

  let l:messages = [
        \ { 'role': 'system', 'content': l:spec.system },
        \ { 'role': 'user',   'content': l:user },
        \ ]

  echom printf('ollama-coder: %s (%d lines, model %s)...',
        \ l:spec.title, l:l2 - l:l1 + 1, g:ollama_coder_chat_model)

  if l:spec.replace
    call s:run_blocking(l:messages, function('s:apply_replace_result', [l:l1, l:l2]))
  else
    call s:run_blocking(l:messages, function('s:open_result_buffer', [l:spec.title, l:lang]))
  endif
endfunction

function! s:run_blocking(messages, OnDone) abort
  call ollama_coder#stream_chat({
        \ 'model':    g:ollama_coder_chat_model,
        \ 'messages': a:messages,
        \ 'stream':   v:true,
        \ 'options':  {
        \   'temperature': g:ollama_coder_temperature,
        \   'num_predict': 2048,
        \ },
        \ },
        \ v:null,
        \ { text, _tc, _code -> call(a:OnDone, [text]) })
endfunction

function! s:strip_fences(s) abort
  " Strip a leading "```lang\n" and trailing "```" if the response is wrapped.
  let l:t = a:s
  let l:t = substitute(l:t, '\v^\s*```[^\n]*\n', '', '')
  let l:t = substitute(l:t, '\v\n?```\s*$', '', '')
  return l:t
endfunction

function! s:apply_replace_result(line1, line2, text) abort
  if empty(trim(a:text))
    echohl WarningMsg | echom 'ollama-coder: empty response' | echohl None
    return
  endif
  let l:new = split(s:strip_fences(a:text), "\n", 1)
  call deletebufline('%', a:line1, a:line2)
  call append(a:line1 - 1, l:new)
  echom 'ollama-coder: applied (' . len(l:new) . ' lines)'
endfunction

function! s:open_result_buffer(title, lang, text) abort
  botright new
  setlocal buftype=nofile bufhidden=hide noswapfile nobuflisted
  execute 'silent file [Ollama: ' . a:title . ']'
  let &l:filetype = (a:title =~? 'tests' || a:title =~? 'explain') ? 'markdown' : a:lang
  call setline(1, split(a:text, "\n", 1))
  setlocal nomodifiable
endfunction

" ---------------- agent: write_file with confirmation ----------------

let s:TOOL_SCHEMAS = [
      \ { 'type': 'function', 'function': {
      \     'name': 'read_file',
      \     'description': 'Read a UTF-8 text file from the user''s workspace. Returns up to 64KB with line numbers.',
      \     'parameters': { 'type': 'object',
      \       'properties': { 'path': { 'type': 'string', 'description': 'workspace-relative path' } },
      \       'required': ['path'] } } },
      \ { 'type': 'function', 'function': {
      \     'name': 'write_file',
      \     'description': 'Create or overwrite a file. The user will see a confirm prompt before applying.',
      \     'parameters': { 'type': 'object',
      \       'properties': {
      \         'path':    { 'type': 'string', 'description': 'workspace-relative path' },
      \         'content': { 'type': 'string', 'description': 'full new file contents' } },
      \       'required': ['path', 'content'] } } },
      \ { 'type': 'function', 'function': {
      \     'name': 'list_files',
      \     'description': 'List files and directories under a workspace-relative path.',
      \     'parameters': { 'type': 'object',
      \       'properties': { 'path': { 'type': 'string' } },
      \       'required': ['path'] } } },
      \ { 'type': 'function', 'function': {
      \     'name': 'web_search',
      \     'description': 'Search the public web (DuckDuckGo by default; Google CSE if g:ollama_coder_google_api_key + g:ollama_coder_google_cse_id are set). Returns top matches.',
      \     'parameters': { 'type': 'object',
      \       'properties': {
      \         'query': { 'type': 'string' },
      \         'limit': { 'type': 'number' } },
      \       'required': ['query'] } } },
      \ ]

let g:ollama_coder_search_backend  = get(g:, 'ollama_coder_search_backend',  'duckduckgo')
let g:ollama_coder_google_api_key  = get(g:, 'ollama_coder_google_api_key',  '')
let g:ollama_coder_google_cse_id   = get(g:, 'ollama_coder_google_cse_id',   '')

function! s:tool_web_search(args) abort
  let l:q = get(a:args, 'query', '')
  if empty(l:q) | return "ERROR: web_search: 'query' is required" | endif
  let l:limit = max([1, min([10, str2nr(string(get(a:args, 'limit', 5)))])])

  if g:ollama_coder_search_backend ==# 'google'
        \ && !empty(g:ollama_coder_google_api_key)
        \ && !empty(g:ollama_coder_google_cse_id)
    let l:url = printf(
          \ 'https://customsearch.googleapis.com/customsearch/v1?key=%s&cx=%s&q=%s&num=%d',
          \ g:ollama_coder_google_api_key,
          \ g:ollama_coder_google_cse_id,
          \ s:url_encode(l:q),
          \ l:limit)
    let l:out = system('curl -sf -m 15 -H "Accept: application/json" ' . shellescape(l:url))
    if v:shell_error != 0
      return 'ERROR: web_search HTTP failure (' . v:shell_error . ')'
    endif
    try
      let l:j = json_decode(l:out)
    catch
      return 'ERROR: web_search invalid JSON from Google CSE'
    endtry
    if type(l:j) == type({}) && has_key(l:j, 'error')
      return printf('ERROR: Google CSE %s: %s',
            \ get(l:j.error, 'code', '?'),
            \ get(l:j.error, 'message', 'unknown'))
    endif
    let l:items = get(l:j, 'items', [])
    let l:results = []
    for l:it in l:items[0 : l:limit - 1]
      let l:title = get(l:it, 'title', '')
      let l:link  = get(l:it, 'link', '')
      let l:snip  = get(l:it, 'snippet', '')
      if !empty(l:title) && !empty(l:link)
        call add(l:results, printf("%d. %s\n   %s\n   %s", len(l:results) + 1, l:title, l:link, l:snip[0:240]))
      endif
    endfor
    if empty(l:results) | return 'No web results for ' . string(l:q) . '.' | endif
    return "Search (Google CSE) for \"" . l:q . "\":\n" . join(l:results, "\n")
  endif

  " DuckDuckGo fallback: lite/html endpoint, scrape result blocks.
  let l:url = 'https://html.duckduckgo.com/html/?q=' . s:url_encode(l:q)
  let l:headers = '-H ' . shellescape('User-Agent: Mozilla/5.0 ollama-coder/0.1')
        \ . ' -H ' . shellescape('Accept: text/html')
  let l:out = system('curl -sfL -m 15 ' . l:headers . ' ' . shellescape(l:url))
  if v:shell_error != 0
    return 'ERROR: web_search HTTP failure (' . v:shell_error . ')'
  endif
  let l:results = s:parse_ddg_html(l:out, l:limit)
  if empty(l:results) | return 'No web results for ' . string(l:q) . '.' | endif
  let l:lines = []
  let l:i = 1
  for l:r in l:results
    call add(l:lines, printf("%d. %s\n   %s\n   %s", l:i, l:r.title, l:r.url, l:r.snippet[0:240]))
    let l:i += 1
  endfor
  return "Search (DuckDuckGo) for \"" . l:q . "\":\n" . join(l:lines, "\n")
endfunction

function! s:url_encode(s) abort
  let l:out = ''
  for l:i in range(strlen(a:s))
    let l:c = a:s[l:i]
    if l:c =~# '[A-Za-z0-9._~-]'
      let l:out .= l:c
    else
      let l:out .= printf('%%%02X', char2nr(l:c))
    endif
  endfor
  return l:out
endfunction

function! s:parse_ddg_html(html, limit) abort
  let l:results = []
  let l:re = '\v\<a[^>]+class\="[^"]*result__a[^"]*"[^>]+href\="([^"]+)"[^>]*\>([^<]*)\</a\>.{-}\<a[^>]+class\="[^"]*result__snippet[^"]*"[^>]*\>(.{-})\</a\>'
  let l:pos = 0
  while len(l:results) < a:limit
    let l:m = matchlist(a:html, l:re, l:pos)
    if empty(l:m) | break | endif
    let l:idx = match(a:html, l:re, l:pos)
    if l:idx < 0 | break | endif
    let l:href = s:html_decode(l:m[1])
    let l:url = s:ddg_unwrap(l:href)
    let l:title = trim(s:strip_tags(l:m[2]))
    let l:snip = trim(s:strip_tags(l:m[3]))
    if !empty(l:url) && !empty(l:title)
      call add(l:results, { 'title': l:title, 'url': l:url, 'snippet': l:snip })
    endif
    let l:pos = l:idx + len(l:m[0])
  endwhile
  return l:results
endfunction

function! s:ddg_unwrap(href) abort
  let l:s = a:href
  if l:s =~# '^//' | let l:s = 'https:' . l:s | endif
  let l:m = matchstr(l:s, '\vuddg\=\zs[^&]+')
  if empty(l:m) | return l:s | endif
  " URL-decode
  let l:m = substitute(l:m, '+', ' ', 'g')
  return substitute(l:m, '\v\%(\x\x)', '\=nr2char(str2nr(submatch(0)[1:], 16))', 'g')
endfunction

function! s:strip_tags(s) abort
  return s:html_decode(substitute(a:s, '\v\<[^>]+\>', '', 'g'))
endfunction

function! s:html_decode(s) abort
  let l:t = a:s
  let l:t = substitute(l:t, '&amp;',  '\&', 'g')
  let l:t = substitute(l:t, '&lt;',   '<',  'g')
  let l:t = substitute(l:t, '&gt;',   '>',  'g')
  let l:t = substitute(l:t, '&quot;', '"',  'g')
  let l:t = substitute(l:t, '&#39;',  "'",  'g')
  let l:t = substitute(l:t, '&nbsp;', ' ',  'g')
  let l:t = substitute(l:t, '&mdash;', '\=nr2char(0x2014)', 'g')
  let l:t = substitute(l:t, '&ndash;', '\=nr2char(0x2013)', 'g')
  let l:t = substitute(l:t, '\v\&#(\d+);', '\=nr2char(str2nr(submatch(1)))', 'g')
  return l:t
endfunction

let s:AGENT_SYSTEM =
      \   "You are an autonomous coding agent running locally in Vim. You have tools to read and write the user's workspace. USE THEM.\n"
      \ . "Rules:\n"
      \ . "1. When the user asks for a NEW file, IMMEDIATELY call write_file with the path and full content.\n"
      \ . "2. When modifying an existing file, call read_file first, then write_file with the COMPLETE new contents.\n"
      \ . "3. If the user did not give a filename, pick a sensible workspace-relative path with the right extension.\n"
      \ . "4. After writing, reply with a one-sentence summary. Do NOT paste the code again."

function! s:project_root() abort
  let l:cwd = getcwd()
  let l:p = l:cwd
  for l:i in range(8)
    if isdirectory(l:p . '/.git')
      return l:p
    endif
    let l:up = fnamemodify(l:p, ':h')
    if l:up ==# l:p | break | endif
    let l:p = l:up
  endfor
  return l:cwd
endfunction

function! s:resolve_inside_root(rel) abort
  let l:root = s:project_root()
  let l:r = trim(a:rel)
  if l:r =~# '\.\.' | throw 'path must not contain "..": ' . a:rel | endif
  let l:r = substitute(l:r, '\\', '/', 'g')
  let l:r = substitute(l:r, '^\./', '', '')
  let l:r = substitute(l:r, '^\~/', '', '')
  let l:r = substitute(l:r, '^/\+', '', '')
  let l:abs = l:root . '/' . l:r
  let l:abs = simplify(l:abs)
  let l:prefix = simplify(l:root . '/')
  if l:abs !=# simplify(l:root) && stridx(l:abs, l:prefix) != 0
    throw 'path escapes the workspace: ' . a:rel
  endif
  return l:abs
endfunction

function! s:tool_read_file(args) abort
  let l:rel = get(a:args, 'path', '')
  if empty(l:rel) | return "ERROR: read_file: 'path' is required" | endif
  try
    let l:abs = s:resolve_inside_root(l:rel)
  catch
    return 'ERROR: ' . v:exception
  endtry
  if !filereadable(l:abs)
    return printf('File not found: %s. (Safe to create with write_file.)', l:rel)
  endif
  let l:lines = readfile(l:abs, '', 4000)
  let l:numbered = []
  let l:i = 1
  for l:ln in l:lines
    call add(l:numbered, printf('%4d: %s', l:i, l:ln))
    let l:i += 1
  endfor
  return printf("File: %s (%d lines)\n%s", l:rel, len(l:lines), join(l:numbered, "\n"))
endfunction

function! s:tool_list_files(args) abort
  let l:rel = get(a:args, 'path', '.')
  try
    let l:abs = s:resolve_inside_root(l:rel)
  catch
    return 'ERROR: ' . v:exception
  endtry
  if !isdirectory(l:abs)
    return 'ERROR: not a directory: ' . l:rel
  endif
  let l:items = readdir(l:abs)
  call sort(l:items)
  let l:out = []
  let l:i = 0
  for l:n in l:items
    if l:i >= 200 | break | endif
    let l:tag = isdirectory(l:abs . '/' . l:n) ? 'dir ' : 'file'
    call add(l:out, l:tag . '  ' . l:n)
    let l:i += 1
  endfor
  return printf("Directory: %s\n%s", l:rel, join(l:out, "\n"))
endfunction

function! s:tool_write_file(args) abort
  let l:rel = get(a:args, 'path', '')
  let l:content = get(a:args, 'content', '')
  if empty(l:rel) | return "ERROR: write_file: 'path' is required" | endif
  try
    let l:abs = s:resolve_inside_root(l:rel)
  catch
    return 'ERROR: ' . v:exception
  endtry
  let l:exists = filereadable(l:abs)
  let l:verb = l:exists ? 'Overwrite' : 'Create'
  let l:prompt = printf('Ollama Coder agent: %s %s (%d chars)? [y/N] ',
        \ tolower(l:verb), l:rel, len(l:content))
  call inputsave()
  let l:ans = input(l:prompt)
  call inputrestore()
  redraw
  if l:ans !~? '^y' | return 'User rejected write to ' . l:rel | endif
  let l:dir = fnamemodify(l:abs, ':h')
  if !isdirectory(l:dir) | call mkdir(l:dir, 'p') | endif
  call writefile(split(l:content, "\n", 1), l:abs, 's')
  echom printf('ollama-coder: %sd %s', tolower(l:verb), l:rel)
  return printf('%sd %s (%d chars).', l:verb . 'd', l:rel, len(l:content))
endfunction

function! s:exec_tool(name, args) abort
  if a:name ==# 'read_file'  | return s:tool_read_file(a:args)  | endif
  if a:name ==# 'list_files' | return s:tool_list_files(a:args) | endif
  if a:name ==# 'write_file' | return s:tool_write_file(a:args) | endif
  if a:name ==# 'web_search' | return s:tool_web_search(a:args) | endif
  return 'ERROR: unknown tool ' . a:name
endfunction

" Public: run an agent turn that may create or modify files.
function! ollama_coder#agent_write(prompt) abort
  call s:chat_buf_ensure()
  call filter(s:chat_history, 'v:val !=# a:prompt')
  call insert(s:chat_history, a:prompt, 0)
  let s:chat_history = s:chat_history[0 : 99]
  call s:save_history()

  call s:chat_append(['', '## user (agent)', a:prompt, '', '## assistant'])
  let l:messages = [
        \ { 'role': 'system', 'content': s:AGENT_SYSTEM },
        \ { 'role': 'user',   'content': a:prompt },
        \ ]
  call s:agent_step(l:messages, 0)
endfunction

function! s:agent_step(messages, step) abort
  if a:step >= g:ollama_coder_agent_max_steps
    call s:chat_append(['', '(agent stopped after ' . a:step . ' steps)'])
    return
  endif
  call ollama_coder#stream_chat({
        \ 'model':    g:ollama_coder_chat_model,
        \ 'messages': a:messages,
        \ 'stream':   v:false,
        \ 'tools':    s:TOOL_SCHEMAS,
        \ 'options':  {
        \   'temperature': g:ollama_coder_temperature,
        \   'num_predict': 2048,
        \ },
        \ },
        \ v:null,
        \ function('s:agent_after_step', [a:messages, a:step]))
endfunction

function! s:agent_after_step(messages, step, text, tool_calls, _code) abort
  if !empty(a:text)
    call s:chat_append_inline(a:text)
  endif
  let l:new_msgs = copy(a:messages)
  let l:assistant = { 'role': 'assistant', 'content': a:text }
  if !empty(a:tool_calls)
    let l:assistant.tool_calls = a:tool_calls
  endif
  call add(l:new_msgs, l:assistant)

  if empty(a:tool_calls)
    call s:chat_append([''])
    return
  endif

  for l:tc in a:tool_calls
    let l:fn = get(l:tc, 'function', {})
    let l:name = get(l:fn, 'name', '?')
    let l:args = get(l:fn, 'arguments', {})
    if type(l:args) == type('')
      try | let l:args = json_decode(l:args) | catch | let l:args = {} | endtry
    endif
    call s:chat_append(['', '> tool: ' . l:name . ' ' . string(l:args)])
    let l:result = s:exec_tool(l:name, l:args)
    call s:chat_append(['  -> ' . substitute(l:result[0 : 200], "\n", ' | ', 'g')])
    call add(l:new_msgs, {'role': 'tool', 'name': l:name, 'content': l:result})
  endfor
  call s:agent_step(l:new_msgs, a:step + 1)
endfunction

" ---------------- history picker ----------------

function! ollama_coder#history_pick() abort
  if empty(s:chat_history)
    echom 'ollama-coder: history is empty.'
    return
  endif
  let l:choices = ['Pick a past prompt:']
  let l:i = 1
  for l:p in s:chat_history[0 : 19]
    call add(l:choices, printf('%d. %s',
          \ l:i, substitute(l:p[0 : 70], "\n", ' ', 'g')))
    let l:i += 1
  endfor
  call inputsave()
  let l:pick = inputlist(l:choices)
  call inputrestore()
  if l:pick > 0 && l:pick <= len(s:chat_history)
    let l:prompt = s:chat_history[l:pick - 1]
    call inputsave()
    let l:edited = input('Edit & send: ', l:prompt)
    call inputrestore()
    if !empty(l:edited)
      call ollama_coder#chat_send(l:edited)
    endif
  endif
endfunction

" ---------------- intent helpers (mirror the VS Code regex set) ----------------

let s:SHOW_INTENT = [
      \ '\v^\s*(show|display|print|render|tell)>',
      \ '\v<(show|display|print|render|tell)\s+me>',
      \ '\v<give\s+me\s+(an?\s+)?(example|snippet|sample|demo|illustration)>',
      \ '\v^\s*(what|how|why|when|where|which|who)>',
      \ '\v<(explain|describe|summari[sz]e|outline|illustrate|demonstrate|walk\s+me\s+through|teach\s+me)>',
      \ '\v<(in\s+(the\s+)?chat|on\s+(the\s+)?screen|inline|without\s+(creating|writing|saving)\s+(a\s+)?file|just\s+show)>',
      \ ]

function! ollama_coder#looks_like_show_intent(text) abort
  for l:re in s:SHOW_INTENT
    if a:text =~? l:re | return 1 | endif
  endfor
  return 0
endfunction

" Direct web search command. Runs the same tool path the agent would use,
" then dumps the formatted results into the chat buffer (no LLM involved).
function! ollama_coder#web_search_show(query) abort
  call s:chat_buf_ensure()
  call s:chat_append(['', '## /search ' . a:query, ''])
  let l:result = s:tool_web_search({ 'query': a:query, 'limit': 8 })
  call s:chat_append(split(l:result, "\n"))
  call s:chat_append([''])
endfunction

let &cpoptions = s:save_cpo
unlet s:save_cpo
