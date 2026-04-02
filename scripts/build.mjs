import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { marked } from 'marked'

const COMMIT_HASH = (process.env.COMMIT_HASH
  || (() => { try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'unknown' } })()
).slice(0, 8)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC  = join(ROOT, 'docs/study-notes')
const OUT  = join(ROOT, 'site')

mkdirSync(OUT, { recursive: true })

// ── Navigation structure ──────────────────────────────────────────────────────

const NAV = [
  {
    label: 'Phase A', cls: 'phase-a',
    items: [
      { file: 'phase-a/task-01-startup.md',        slug: 'task-01-startup',        title: 'Task 1 · 启动流程' },
      { file: 'phase-a/task-02-data-structures.md', slug: 'task-02-data-structures', title: 'Task 2 · 数据结构' },
      { file: 'phase-a/task-03-system-overview.md', slug: 'task-03-system-overview', title: 'Task 3 · 子系统' },
    ],
  },
  {
    label: 'Phase B', cls: 'phase-b',
    items: [
      { file: 'phase-b/task-04-agent-loop.md',      slug: 'task-04-agent-loop',      title: 'Task 4 · Agent 循环' },
      { file: 'phase-b/task-05-tool-system.md',     slug: 'task-05-tool-system',     title: 'Task 5 · 工具系统' },
      { file: 'phase-b/task-06-multi-agent.md',     slug: 'task-06-multi-agent',     title: 'Task 6 · 多智能体' },
      { file: 'phase-b/task-07-security.md',        slug: 'task-07-security',        title: 'Task 7 · 安全沙箱' },
      { file: 'phase-b/task-08-plugins-skills.md',  slug: 'task-08-plugins-skills',  title: 'Task 8 · 插件技能' },
      { file: 'phase-b/task-09-memory.md',          slug: 'task-09-memory',          title: 'Task 9 · 上下文管理' },
    ],
  },
  {
    label: 'Phase C', cls: 'phase-c',
    items: [
      { file: 'phase-c/task-10-cross-cutting.md',  slug: 'task-10-cross-cutting',  title: 'Task 10 · 横切关注点' },
      { file: 'phase-c/task-12-reflection.md',     slug: 'task-12-reflection',     title: 'Task 12 · 复盘总结' },
    ],
  },
  {
    label: '模式卡片', cls: 'phase-p',
    items: [
      { file: 'patterns/README.md',                          slug: 'patterns',    title: '模式卡片总览' },
      { file: 'patterns/01-streaming-tool-loop.md',          slug: 'pattern-01',  title: '01 · 流式工具循环' },
      { file: 'patterns/02-tool-interface-abstraction.md',   slug: 'pattern-02',  title: '02 · Tool 接口抽象' },
      { file: 'patterns/03-progress-reporting-decoupling.md',slug: 'pattern-03',  title: '03 · 进度上报解耦' },
      { file: 'patterns/04-layered-agent-orchestration.md',  slug: 'pattern-04',  title: '04 · 分层 Agent 编排' },
      { file: 'patterns/05-coordinator-worker-pattern.md',   slug: 'pattern-05',  title: '05 · Coordinator 模式' },
      { file: 'patterns/06-multi-layer-security-defense.md', slug: 'pattern-06',  title: '06 · 多层防御安全' },
      { file: 'patterns/07-declarative-permission-rules.md', slug: 'pattern-07',  title: '07 · 声明式权限' },
      { file: 'patterns/08-plugin-hot-loading.md',           slug: 'pattern-08',  title: '08 · 插件热加载' },
      { file: 'patterns/09-layered-memory-architecture.md',  slug: 'pattern-09',  title: '09 · 分层记忆' },
      { file: 'patterns/10-context-compression.md',          slug: 'pattern-10',  title: '10 · 上下文压缩' },
    ],
  },
  {
    label: '苏格拉底专题', cls: 'phase-s',
    items: [
      { file: 'superpowers/socratic-01-security-and-agent-loop.md', slug: 'socratic-01-security-and-agent-loop', title: '专题 01 · 安全与 Agent 循环' },
    ],
  },
]

// Flat map: original path / filename → slug
const pathToSlug = { 'INDEX.md': 'index' }
for (const group of NAV) {
  for (const item of group.items) {
    pathToSlug[item.file] = item.slug
    pathToSlug[item.file.split('/').pop()] = item.slug
  }
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

const renderer = new marked.Renderer()

renderer.link = function (href, title, text) {
  if (href && href.endsWith('.md')) {
    const key = href.replace(/^.*?((phase-[abc]|patterns)\/[^/]+\.md|[^/]+\.md)$/, '$1')
    const slug = pathToSlug[key] || pathToSlug[href.split('/').pop()]
    if (slug) href = slug === 'index' ? 'index.html' : `${slug}.html`
  }
  return `<a href="${href}"${title ? ` title="${title}"` : ''}>${text}</a>`
}

renderer.code = function (code, lang) {
  return `<div class="code-block"><pre>${escapeHtml(String(code ?? ''))}</pre></div>`
}

renderer.table = function (header, body) {
  return `<div class="table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`
}

marked.use({ renderer })

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function stripFrontMatter(src) {
  return src.replace(/^---\s*\n---\s*\n/, '').replace(/^---\s*\n[\s\S]*?---\s*\n/, '')
}

// ── Sidebar HTML ──────────────────────────────────────────────────────────────

function buildSidebar(currentSlug) {
  let rows = ''
  for (const group of NAV) {
    rows += `<tr class="dir"><td></td><td class="phase-label ${group.cls}">${group.label}/</td></tr>`
    for (const item of group.items) {
      const active = item.slug === currentSlug
      const href   = item.slug === 'index' ? 'index.html' : `${item.slug}.html`
      rows += `<tr class="${active ? 'active' : 'file'}">
        <td>-rw-r--r--</td>
        <td><a href="${href}">${item.title}</a></td>
      </tr>`
    }
  }

  return `
    <div class="prompt"><b>guest@claude-study</b>:~/notes$ ls<span class="cursor"></span></div>
    <table class="ls-table">
      <thead><tr><th>PERMS</th><th>NAME</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');

*{margin:0;padding:0;box-sizing:border-box}
:root{--green:#00e676;--green-dim:#00b050;--green-bright:#69ff9c;--bg:#0a0d0a;--bg2:#0d110d;--border:#1a2e1a}

html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--green);font-family:'JetBrains Mono','Courier New',monospace;font-size:13px;line-height:1.6;display:flex;flex-direction:column}

body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.08) 2px,rgba(0,0,0,.08) 4px);pointer-events:none;z-index:9999}

@keyframes flicker{0%,100%{opacity:1}92%{opacity:1}93%{opacity:.97}94%{opacity:1}96%{opacity:.98}97%{opacity:1}}
body{animation:flicker 8s infinite}

@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.cursor{display:inline-block;width:8px;height:14px;background:var(--green);vertical-align:middle;animation:blink 1s step-end infinite;margin-left:2px}

.glow{text-shadow:0 0 8px var(--green),0 0 20px rgba(0,230,118,.4)}

/* header */
.ascii-header{padding:18px 28px 12px;border-bottom:1px dashed var(--border);flex-shrink:0}
.ascii-title{font-size:10.5px;line-height:1.2;white-space:pre;color:var(--green);text-shadow:0 0 10px rgba(0,230,118,.5);overflow:hidden}
.header-meta{color:var(--green-dim);font-size:11px;display:flex;justify-content:space-between;align-items:center;margin-top:8px;white-space:nowrap;gap:16px}

/* layout */
.layout{flex:1;display:flex;overflow:hidden}

/* sidebar */
.sidebar{width:260px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px dashed var(--border);overflow:hidden}
.sidebar-scroll{flex:1;overflow-y:auto;padding:16px 0 8px}
.sidebar-scroll::-webkit-scrollbar{width:4px}
.sidebar-scroll::-webkit-scrollbar-thumb{background:var(--border)}
.prompt{color:var(--green-dim);padding:0 16px 10px;font-size:11.5px;white-space:nowrap;overflow:hidden}
.prompt b{color:var(--green-bright)}
.ls-table{width:100%;border-collapse:collapse;table-layout:fixed}
.ls-table th{padding:3px 16px;text-align:left;color:var(--green-dim);font-size:10px;letter-spacing:2px;border-bottom:1px solid var(--border);font-weight:700;white-space:nowrap}
.ls-table th:first-child{width:88px}
.ls-table td{padding:4px 16px;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ls-table tr.dir td{color:var(--green-bright);font-weight:700}
.ls-table tr.file td{color:var(--green-dim)}
.ls-table tr.file a{color:inherit;text-decoration:none}
.ls-table tr.active td{background:var(--green);color:#000;font-weight:700}
.ls-table tr.active a{color:#000;text-decoration:none}
.ls-table tr:hover:not(.active) td{background:rgba(0,230,118,.07);color:var(--green);cursor:pointer}
.ls-table tr:hover:not(.active) a{color:var(--green)}
.phase-label{font-size:11px}
.phase-a{color:#69ff9c}.phase-b{color:#40c8ff}.phase-c{color:#ffd740}.phase-s{color:#ce93d8}.phase-p{color:#ff80ab}
.sidebar-footer{padding:10px 16px;color:var(--green-dim);font-size:11px;border-top:1px dashed var(--border);flex-shrink:0}

/* main */
.main{flex:1;overflow-y:auto;padding:24px 40px 40px}
.main::-webkit-scrollbar{width:4px}
.main::-webkit-scrollbar-thumb{background:var(--border)}
.page-prompt{color:var(--green-dim);margin-bottom:18px;font-size:12px}
.page-prompt b{color:var(--green-bright)}

/* markdown content */
.content h1{font-size:20px;font-weight:700;color:var(--green-bright);margin-bottom:16px;text-shadow:0 0 12px rgba(105,255,156,.4)}
.content h1::before{content:'# ';color:var(--green-dim)}
.content h2{font-size:15px;font-weight:700;color:var(--green);margin:28px 0 10px}
.content h2::before{content:'## ';color:var(--green-dim)}
.content h3{font-size:13px;font-weight:700;color:var(--green-dim);margin:20px 0 8px}
.content h3::before{content:'### ';color:var(--border)}
.content p{color:var(--green-dim);line-height:1.85;margin-bottom:16px;font-size:13px}
.content a{color:var(--green);text-decoration:none;border-bottom:1px dashed var(--green-dim)}
.content a:hover{color:var(--green-bright)}
.content strong{color:var(--green)}
.content em{color:var(--green-dim)}
.content code{color:var(--green-bright);font-size:12px}
.content ul,.content ol{color:var(--green-dim);padding-left:20px;margin-bottom:16px;font-size:13px}
.content li{margin-bottom:4px;line-height:1.7}
.content hr{border:none;border-top:1px dashed var(--border);margin:20px 0}
.content blockquote{border-left:3px solid var(--green-dim);padding-left:14px;color:var(--green-dim);margin:16px 0;font-style:italic}

/* code blocks */
.code-block{background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--green-dim);border-radius:4px;padding:16px 20px;margin:16px 0 24px;overflow-x:auto}
.code-block pre{font-size:12px;line-height:1.75;color:var(--green-dim);white-space:pre}

/* tables */
.table-wrap{overflow-x:auto;margin:16px 0}
.table-wrap table{border-collapse:collapse;font-size:12px;width:100%}
.table-wrap th{padding:6px 14px;color:var(--green);border-bottom:1px solid var(--green-dim);text-align:left;letter-spacing:1px;font-size:10px;text-transform:uppercase}
.table-wrap td{padding:6px 14px;color:var(--green-dim);border-bottom:1px dashed var(--border)}
.table-wrap tr:hover td{background:rgba(0,230,118,.04)}

/* status bar */
.statusbar{border-top:1px dashed var(--border);padding:5px 28px;display:flex;justify-content:space-between;font-size:11px;color:var(--green-dim);background:var(--bg2);flex-shrink:0;white-space:nowrap}
.statusbar b{color:var(--green)}

@keyframes typing{from{width:0}to{width:100%}}
.typed{overflow:hidden;white-space:nowrap;display:inline-block;animation:typing 1.2s steps(40) .3s both}

/* matrix rain canvas */
#matrix-canvas{position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;opacity:.045}
.ascii-header,.layout,.statusbar{position:relative;z-index:1}

/* mobile menu toggle */
.menu-toggle{display:none;background:none;border:1px solid var(--green-dim);color:var(--green);font-family:inherit;font-size:11px;padding:3px 10px;cursor:pointer;letter-spacing:1px}
.menu-toggle:hover{border-color:var(--green);color:var(--green-bright)}

/* mobile */
@media(max-width:700px){
  html,body{overflow:auto}
  .ascii-title{font-size:6px}
  .header-meta{font-size:10px}
  .menu-toggle{display:inline-block}
  .layout{flex-direction:column}
  .sidebar{width:100%;border-right:none;border-bottom:1px dashed var(--border);display:none;max-height:60vh}
  .sidebar.open{display:flex}
  .main{padding:16px 20px 40px}
  .content h1{font-size:16px}
  .page-prompt{font-size:11px}
  .statusbar{font-size:10px;padding:5px 16px}
}
`

// ── HTML template ─────────────────────────────────────────────────────────────

const ASCII = `  ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗     ██████╗ ██████╗ ██████╗ ███████╗
 ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██║     ██║     ███████║██║   ██║██║  ██║█████╗      ██║     ██║   ██║██║  ██║█████╗
 ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝      ██║     ██║   ██║██║  ██║██╔══╝
 ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗    ╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝`

function buildPage({ slug, title, promptPath, content, sidebarHtml, totalFiles }) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — Claude Code 源码学习笔记</title>
<style>${CSS}</style>
</head>
<body>
<canvas id="matrix-canvas"></canvas>
<script>
(function(){
  const c=document.getElementById('matrix-canvas')
  const ctx=c.getContext('2d')
  const chars='アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン01'
  let cols,drops
  function resize(){
    c.width=window.innerWidth;c.height=window.innerHeight
    cols=Math.floor(c.width/18);drops=Array(cols).fill(1)
  }
  resize();window.addEventListener('resize',resize)
  setInterval(function(){
    ctx.fillStyle='rgba(10,13,10,0.05)'
    ctx.fillRect(0,0,c.width,c.height)
    ctx.fillStyle='#00e676';ctx.font='14px monospace'
    drops.forEach(function(y,i){
      ctx.fillText(chars[Math.random()*chars.length|0],i*18,y*18)
      if(y*18>c.height&&Math.random()>0.975)drops[i]=0
      drops[i]++
    })
  },60)
})()
</script>

<header class="ascii-header">
<pre class="ascii-title glow">${ASCII}</pre>
<div class="header-meta">
  <span class="typed">Last updated: 2026-03-31 &nbsp;|&nbsp; claude-code main branch</span>
  <span style="display:flex;align-items:center;gap:12px">
    <button class="menu-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open')">[MENU]</button>
    <span>[STUDY NOTES v1.0]</span>
  </span>
</div>
</header>

<div class="layout">
  <nav class="sidebar">
    <div class="sidebar-scroll">
      ${sidebarHtml}
    </div>
    <div class="sidebar-footer">${totalFiles} files found.<br>@ ${COMMIT_HASH}</div>
  </nav>

  <main class="main">
    <div class="page-prompt">
      <b>guest@claude-study</b>:${promptPath}$ <span style="color:var(--green)">cat ${slug}.md</span>
    </div>
    <div class="content">
      ${content}
    </div>
  </main>
</div>

<footer class="statusbar">
  <span>[MODE: NORMAL] &nbsp; [ENCODING: UTF-8] &nbsp; [BRANCH: main]</span>
  <span>© 2026 &nbsp;<b>claude-code-study</b></span>
</footer>

</body>
</html>`
}

// ── Build pages ───────────────────────────────────────────────────────────────

const allItems = NAV.flatMap(g => g.items)
const totalFiles = allItems.length

// Index page
const indexMd = stripFrontMatter(readFileSync(join(SRC, 'INDEX.md'), 'utf8'))
const indexHtml = buildPage({
  slug: 'index',
  title: 'Claude Code 源码学习笔记',
  promptPath: '~/notes',
  content: marked.parse(indexMd),
  sidebarHtml: buildSidebar('index'),
  totalFiles,
})
writeFileSync(join(OUT, 'index.html'), indexHtml)
console.log('✓ index.html')

// Write .nojekyll so GitHub Pages doesn't run Jekyll
writeFileSync(join(OUT, '.nojekyll'), '')

// All other pages
for (const group of NAV) {
  for (const item of group.items) {
    const srcPath = join(SRC, item.file)
    let md
    try {
      md = readFileSync(srcPath, 'utf8')
    } catch {
      console.warn(`  skip (not found): ${item.file}`)
      continue
    }

    md = stripFrontMatter(md)
    const phaseDir = item.file.startsWith('patterns') ? '~/notes/patterns' : `~/notes/${item.file.split('/')[0]}`

    const html = buildPage({
      slug: item.slug,
      title: item.title,
      promptPath: phaseDir,
      content: marked.parse(md),
      sidebarHtml: buildSidebar(item.slug),
      totalFiles,
    })

    writeFileSync(join(OUT, `${item.slug}.html`), html)
    console.log(`✓ ${item.slug}.html`)
  }
}

console.log(`\nBuild complete → site/ (${allItems.length + 1} pages)`)
