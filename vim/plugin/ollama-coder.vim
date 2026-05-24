" Ollama Coder for Vim / Neovim
" Local-only LLM coding assistant powered by an Ollama server.
" Sister plugin to the VS Code extension in this repo.
"
" Requires:
"   - Vim 8.0+ or Neovim 0.5+  (for +job / jobstart)
"   - curl on $PATH
"   - a running Ollama server (default: http://localhost:11434)

if exists('g:loaded_ollama_coder') | finish | endif
let g:loaded_ollama_coder = 1

if !has('job') && !has('nvim')
  echohl WarningMsg
  echom 'ollama-coder: needs Vim 8 +job or Neovim. Plugin disabled.'
  echohl None
  finish
endif

if !executable('curl')
  echohl WarningMsg
  echom 'ollama-coder: curl is required on $PATH. Plugin disabled.'
  echohl None
  finish
endif

let s:save_cpo = &cpoptions
set cpoptions&vim

" -- defaults (override in your vimrc / init.lua) --
let g:ollama_coder_endpoint         = get(g:, 'ollama_coder_endpoint',         'http://localhost:11434')
let g:ollama_coder_chat_model       = get(g:, 'ollama_coder_chat_model',       'llama3.1:8b')
let g:ollama_coder_completion_model = get(g:, 'ollama_coder_completion_model', 'qwen2.5-coder:1.5b-base')
let g:ollama_coder_temperature      = get(g:, 'ollama_coder_temperature',      0.2)
let g:ollama_coder_context_chars    = get(g:, 'ollama_coder_context_chars',    4000)
let g:ollama_coder_agent_max_steps  = get(g:, 'ollama_coder_agent_max_steps',  8)
let g:ollama_coder_default_maps     = get(g:, 'ollama_coder_default_maps',     1)

" -- commands --
command! -nargs=? OllamaChat              call ollama_coder#chat_open(<q-args>)
command! -range -nargs=? OllamaAsk        call ollama_coder#action('ask',     <line1>, <line2>, <q-args>)
command! -range OllamaExplain             call ollama_coder#action('explain', <line1>, <line2>, '')
command! -range OllamaRefactor            call ollama_coder#action('refactor',<line1>, <line2>, '')
command! -range OllamaFix                 call ollama_coder#action('fix',     <line1>, <line2>, '')
command! -range OllamaDocs                call ollama_coder#action('docs',    <line1>, <line2>, '')
command! -range OllamaTests               call ollama_coder#action('tests',   <line1>, <line2>, '')
command! OllamaModel                      call ollama_coder#pick_model()
command! OllamaStop                       call ollama_coder#stop()
command! OllamaHistory                    call ollama_coder#history_pick()
command! -nargs=+ OllamaWrite             call ollama_coder#agent_write(<q-args>)
command! -nargs=+ OllamaSend              call ollama_coder#chat_send(<q-args>)
command! -nargs=+ OllamaSearch            call ollama_coder#web_search_show(<q-args>)

" -- default keymaps (set g:ollama_coder_default_maps = 0 to disable) --
if g:ollama_coder_default_maps
  nnoremap <silent> <leader>oc :OllamaChat<CR>
  nnoremap <silent> <leader>om :OllamaModel<CR>
  nnoremap <silent> <leader>os :OllamaStop<CR>
  nnoremap <silent> <leader>oh :OllamaHistory<CR>
  xnoremap <silent> <leader>oe :<C-u>'<,'>OllamaExplain<CR>
  xnoremap <silent> <leader>or :<C-u>'<,'>OllamaRefactor<CR>
  xnoremap <silent> <leader>of :<C-u>'<,'>OllamaFix<CR>
  xnoremap <silent> <leader>od :<C-u>'<,'>OllamaDocs<CR>
  xnoremap <silent> <leader>ot :<C-u>'<,'>OllamaTests<CR>
  xnoremap <silent> <leader>oa :<C-u>'<,'>OllamaAsk<CR>
endif

let &cpoptions = s:save_cpo
unlet s:save_cpo
