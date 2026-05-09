import os
import re
import json
import zipfile
import uuid
import sys

# --- UTILITIES ---

def escape_xml(unsafe):
    return unsafe.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;').replace("'", '&apos;')

def sanitize_filename(name):
    return re.sub(r'[\/\\?%*:|"<>]', '_', name)

def get_inner_content(full_html):
    """Strips the <html>, <head>, and <h1> wrappers to get the pure chapter content."""
    match = re.search(r'<h1>.*?</h1>\s*(.*?)\s*</body>', full_html, re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else full_html

def get_title_from_h1(full_html):
    match = re.search(r'<h1>(.*?)</h1>', full_html, re.IGNORECASE)
    return match.group(1).strip() if match else "Unknown Title"

def natural_sort_key(s):
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]

# --- EXTRACTORS ---

def extract_from_html(filepath):
    print("  -> Parsing Webnovel App HTML...")
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    title_match = re.search(r'<title>(.*?)</title>', content, re.IGNORECASE)
    book_title = title_match.group(1).strip() if title_match else "Converted Book"

    match = re.search(r'const chapters = (\[.*?\]);\s*const BOOK_ID', content, re.DOTALL)
    if not match:
        raise ValueError("Could not find chapter JSON array in HTML file.")
        
    chapters = json.loads(match.group(1))
    return book_title, chapters

def extract_from_zip(filepath):
    print("  -> Parsing ZIP Archive...")
    book_title = os.path.splitext(os.path.basename(filepath))[0]
    chapters = []

    with zipfile.ZipFile(filepath, 'r') as zin:
        namelist = zin.namelist()
        trans_files = sorted([f for f in namelist if f.startswith('Translated/') and f.endswith('.html')], key=natural_sort_key)
        raw_files = {re.search(r'\[(\d+)\]', f).group(1): f for f in namelist if f.startswith('Raw/') and f.endswith('.html') and re.search(r'\[(\d+)\]', f)}

        for t_file in trans_files:
            num_match = re.search(r'\[(\d+)\]', t_file)
            num = num_match.group(1) if num_match else "00"
            
            t_html = zin.read(t_file).decode('utf-8', errors='ignore')
            title = get_title_from_h1(t_html)
            content = get_inner_content(t_html)

            raw_content = None
            if num in raw_files:
                r_html = zin.read(raw_files[num]).decode('utf-8', errors='ignore')
                raw_content = get_inner_content(r_html)

            chapters.append({
                "title": title,
                "content": content,
                "rawContent": raw_content
            })

    return book_title, chapters

def extract_from_epub(filepath):
    print("  -> Parsing EPUB eBook...")
    book_title = "Converted Book"
    chapters = []

    with zipfile.ZipFile(filepath, 'r') as zin:
        namelist = zin.namelist()
        
        if 'OEBPS/content.opf' in namelist:
            opf = zin.read('OEBPS/content.opf').decode('utf-8', errors='ignore')
            m = re.search(r'<dc:title>(.*?)</dc:title>', opf)
            if m: book_title = m.group(1)

        trans_files = sorted([f for f in namelist if f.startswith('OEBPS/Text/chapter_trans_') and f.endswith('.html')], key=natural_sort_key)
        
        for t_file in trans_files:
            num = re.search(r'_trans_(\d+)', t_file).group(1)
            
            t_html = zin.read(t_file).decode('utf-8', errors='ignore')
            title = get_title_from_h1(t_html)
            content = get_inner_content(t_html)

            raw_content = None
            r_file = f'OEBPS/Text/chapter_raw_{num}.html'
            if r_file in namelist:
                r_html = zin.read(r_file).decode('utf-8', errors='ignore')
                raw_content = get_inner_content(r_html)

            chapters.append({
                "title": title,
                "content": content,
                "rawContent": raw_content
            })

    return book_title, chapters

# --- GENERATORS ---

def generate_html_app(book_title, chapters, out_filepath):
    print(f"  [+] Generating HTML App: {os.path.basename(out_filepath)}")
    chapters_json = json.dumps(chapters, ensure_ascii=False).replace('</', '<\\/')
    safe_book_id = sanitize_filename(book_title)

    template = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{book_title}</title>
    <style>
        :root {{ --bg: #fdfdfd; --text: #111; --border: #eaeaea; --btn-bg: #fff; --btn-hover: #f0f0f0; --accent: #8b5cf6; --raw: #ef4444; --box-bg: #f4f4f5; }}
        body.dark-mode {{ --bg: #121212; --text: #eee; --border: #333; --btn-bg: #1e1e1e; --btn-hover: #2a2a2a; --box-bg: #1f1f1f; }}
        body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; transition: background 0.2s, color 0.2s; -webkit-tap-highlight-color: transparent;}}
        .container {{ max-width: 800px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }}
        .toolbar {{ display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--border); z-index: 100; gap: 12px; flex-wrap: wrap; box-shadow: 0 2px 10px rgba(0,0,0,0.05);}}
        .toolbar-group {{ display: flex; gap: 8px; }}
        .bottom-nav {{ display: flex; justify-content: space-between; padding: 30px 20px 50px 20px; border-top: 1px solid var(--border); margin-top: auto; background: var(--bg); gap: 20px; }}
        body.hide-ui .toolbar {{ display: none !important; }}
        body.index-active #reader-view, body.index-active .bottom-nav {{ display: none !important; }}
        body.index-active #index-view {{ display: block !important; }}
        button {{ background: var(--btn-bg); color: var(--text); border: 1px solid var(--border); padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; transition: background 0.2s, transform 0.1s; display: flex; align-items: center; gap: 6px; user-select: none; touch-action: manipulation;}}
        button:hover:not(:disabled) {{ background: var(--btn-hover); }}
        button:active:not(:disabled) {{ transform: scale(0.96); }}
        button:disabled {{ opacity: 0.4; cursor: not-allowed; }}
        .bottom-nav button {{ padding: 12px 24px; font-size: 16px; flex: 1; justify-content: center; }}
        .content-area {{ padding: 50px 20px 80px 20px; flex-grow: 1; }}
        body.hide-ui .content-area {{ padding-top: 30px; }}
        .chapter-title {{ text-align: center; margin-top: 0; margin-bottom: 30px; font-size: 1.8em; border-bottom: 1px solid var(--border); padding-bottom: 15px; transition: color 0.3s; }}
        .chapter-body {{ line-height: 1.8; font-size: 18px; }}
        .chapter-body p {{ margin-bottom: 1.2em; }}
        .chapter-body blockquote {{ border-left: 4px solid var(--accent); padding-left: 1rem; margin-left: 0; font-style: italic; opacity: 0.85; }}
        .chapter-body hr {{ border: 0; border-top: 1px solid var(--border); margin: 3em 0; }}
        .box {{ border: 1px solid var(--border); background-color: var(--box-bg); border-radius: 8px; padding: 16px; margin: 24px 0; }}
        .box p:last-child {{ margin-bottom: 0; }}
        .index-view {{ display: none; }}
        .section-title {{ font-size: 1.2em; border-bottom: 2px solid var(--accent); padding-bottom: 5px; margin-bottom: 10px; color: var(--accent); margin-top: 2em; }}
        .index-list {{ list-style: none; padding: 0; margin: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 30px;}}
        .index-item {{ padding: 16px 20px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 16px; transition: background 0.2s;}}
        .index-item:last-child {{ border-bottom: none; }}
        .index-item:hover {{ background: var(--btn-hover); }}
        .index-item.active {{ font-weight: bold; color: var(--accent); background: var(--btn-hover); border-left: 4px solid var(--accent); padding-left: 16px;}}
        @media (max-width: 500px) {{ .toolbar {{ flex-direction: column-reverse; padding: 12px 15px; }} .toolbar-group {{ width: 100%; justify-content: space-between; }} button {{ flex: 1; justify-content: center; }} .content-area {{ padding: 40px 15px 40px 15px; }} .bottom-nav {{ padding: 20px 15px 40px 15px; gap: 10px; }} }}
    </style>
</head>
<body>
    <div class="container">
        <div class="toolbar">
            <div class="toolbar-group">
                <button id="btn-prev">◀ Prev</button>
                <button id="btn-index" style="color: var(--accent);" title="Hold to toggle Raws">📑 Index</button>
                <button id="btn-next">Next ▶</button>
            </div>
            <div class="toolbar-group">
                <button id="btn-font-dec" title="Decrease Font">A-</button>
                <button id="btn-font-inc" title="Increase Font">A+</button>
                <button id="btn-theme" title="Toggle Theme">🌙</button>
            </div>
        </div>
        <div class="content-area" id="content-area">
            <div id="reader-view">
                <h1 id="chapter-title" class="chapter-title"></h1>
                <div id="chapter-body" class="chapter-body"></div>
            </div>
            <div id="index-view" class="index-view">
                <h1 class="chapter-title" style="border:none;">Table of Contents</h1>
                <p id="random-tip" style="text-align:center; color:#888; font-size:14px; margin-top:-20px; padding: 0 10px;"></p>
                <h3 class="section-title" id="trans-header">Translated</h3>
                <ul id="index-list-trans" class="index-list"></ul>
                <h3 class="section-title" id="raw-header" style="display:none; color: var(--raw); border-color: var(--raw);">Raws</h3>
                <ul id="index-list-raw" class="index-list" style="display: none;"></ul>
            </div>
        </div>
        <div id="bottom-nav" class="bottom-nav">
            <button id="btn-prev-btm">◀ Previous</button>
            <button id="btn-next-btm">Next ▶</button>
        </div>
    </div>
    <script>
        const chapters = {chapters_json};
        const BOOK_ID = "{safe_book_id}";
        let currentIndex = 0; let fontSize = 18; let isIndexView = false; let isShowingRaw = false;
        const tips = ["Hold the Index button for 0.5s to instantly toggle between Translation & Raw.", "Double-tap anywhere on the text to hide the reading UI for full immersion.", "Hold the Previous button to instantly jump to the top of the chapter.", "Hold the Next button to instantly jump to the bottom of the chapter."];
        const els = {{ title: document.getElementById('chapter-title'), body: document.getElementById('chapter-body'), contentArea: document.getElementById('content-area'), indexListTrans: document.getElementById('index-list-trans'), indexListRaw: document.getElementById('index-list-raw'), rawHeader: document.getElementById('raw-header'), tip: document.getElementById('random-tip'), btnPrev: document.getElementById('btn-prev'), btnNext: document.getElementById('btn-next'), btnPrevBtm: document.getElementById('btn-prev-btm'), btnNextBtm: document.getElementById('btn-next-btm'), btnIndex: document.getElementById('btn-index'), btnFontDec: document.getElementById('btn-font-dec'), btnFontInc: document.getElementById('btn-font-inc'), btnTheme: document.getElementById('btn-theme') }};
        let scrollMap = JSON.parse(localStorage.getItem('ro_scroll_' + BOOK_ID) || '{{}}');
        let scrollTimeout;
        window.addEventListener('scroll', () => {{ if (isIndexView) return; if (!scrollTimeout) {{ scrollTimeout = setTimeout(() => {{ scrollMap[currentIndex + '_' + isShowingRaw] = window.scrollY; localStorage.setItem('ro_scroll_' + BOOK_ID, JSON.stringify(scrollMap)); scrollTimeout = null; }}, 150); }} }});
        let lastClick = 0;
        els.contentArea.addEventListener('click', function(e) {{ if (isIndexView) return; if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return; let currentTime = new Date().getTime(); let tapLength = currentTime - lastClick; if (tapLength < 300 && tapLength > 0) {{ document.body.classList.toggle('hide-ui'); e.preventDefault(); }} lastClick = currentTime; }});
        function updateTip() {{ if(els.tip) els.tip.textContent = "(Tip: " + tips[Math.floor(Math.random() * tips.length)] + ")"; }}
        function renderChapter(index, showRaw) {{ if (index < 0 || index >= chapters.length) return; if (!isIndexView) {{ scrollMap[currentIndex + '_' + isShowingRaw] = window.scrollY; localStorage.setItem('ro_scroll_' + BOOK_ID, JSON.stringify(scrollMap)); }} currentIndex = index; isShowingRaw = showRaw; const chapter = chapters[currentIndex]; els.title.textContent = showRaw ? chapter.title + ' (Raw)' : chapter.title; els.body.innerHTML = showRaw ? chapter.rawContent : chapter.content; els.btnPrev.disabled = currentIndex === 0; els.btnPrevBtm.disabled = currentIndex === 0; els.btnNext.disabled = currentIndex === chapters.length - 1; els.btnNextBtm.disabled = currentIndex === chapters.length - 1; els.title.style.color = showRaw ? 'var(--raw)' : ''; const targetScroll = scrollMap[currentIndex + '_' + isShowingRaw] || 0; setTimeout(() => {{ window.scrollTo(0, targetScroll); }}, 30); localStorage.setItem('ro_progress_' + BOOK_ID, currentIndex + '_' + isShowingRaw); if(isIndexView) populateIndex(); }}
        function populateIndex() {{ els.indexListTrans.innerHTML = ''; chapters.forEach((chap, idx) => {{ const li = document.createElement('li'); li.className = 'index-item' + (idx === currentIndex && !isShowingRaw ? ' active' : ''); li.textContent = chap.title; li.onclick = () => {{ toggleIndex(); renderChapter(idx, false); }}; els.indexListTrans.appendChild(li); }}); const hasRaws = chapters.some(c => c.rawContent); if (hasRaws) {{ els.rawHeader.style.display = 'block'; els.indexListRaw.style.display = 'block'; els.indexListRaw.innerHTML = ''; chapters.forEach((chap, idx) => {{ if (!chap.rawContent) return; const li = document.createElement('li'); li.className = 'index-item' + (idx === currentIndex && isShowingRaw ? ' active' : ''); li.textContent = chap.title + ' (Raw)'; if (idx === currentIndex && isShowingRaw) {{ li.style.color = 'var(--raw)'; li.style.borderLeftColor = 'var(--raw)'; }} li.onclick = () => {{ toggleIndex(); renderChapter(idx, true); }}; els.indexListRaw.appendChild(li); }}); }} }}
        function toggleIndex() {{ isIndexView = !isIndexView; if (isIndexView) {{ updateTip(); document.body.classList.add('index-active'); populateIndex(); setTimeout(() => {{ const activeEl = document.querySelector('.index-view .active'); if (activeEl) activeEl.scrollIntoView({{ block: 'center' }}); }}, 50); }} else {{ document.body.classList.remove('index-active'); window.scrollTo(0, scrollMap[currentIndex + '_' + isShowingRaw] || 0); }} }}
        function toggleTheme() {{ document.body.classList.toggle('dark-mode'); const isDark = document.body.classList.contains('dark-mode'); els.btnTheme.textContent = isDark ? '☀️' : '🌙'; localStorage.setItem('ro_theme', isDark ? 'dark' : 'light'); }}
        function changeFontSize(delta) {{ if (isIndexView) return; const oldScroll = window.scrollY; const oldHeight = document.documentElement.scrollHeight || 1; fontSize += delta; if (fontSize < 12) fontSize = 12; if (fontSize > 36) fontSize = 36; els.body.style.fontSize = fontSize + 'px'; localStorage.setItem('ro_fontsize', fontSize); setTimeout(() => {{ const newHeight = document.documentElement.scrollHeight; window.scrollTo(0, oldScroll * (newHeight / oldHeight)); }}, 10); }}
        function setupHoldButton(btn, onClick, onHold) {{ if (!btn) return; let pressTimer; let startY = 0; let isLongPress = false; let isDragging = false; btn.addEventListener('pointerdown', (e) => {{ if (btn.disabled) return; startY = e.clientY; isLongPress = false; isDragging = false; btn.setPointerCapture(e.pointerId); pressTimer = setTimeout(() => {{ isLongPress = true; onHold(); }}, 500); }}); btn.addEventListener('pointermove', (e) => {{ if (Math.abs(e.clientY - startY) > 15) {{ isDragging = true; if (pressTimer) {{ clearTimeout(pressTimer); pressTimer = null; }} }} }}); btn.addEventListener('pointerup', (e) => {{ if (btn.disabled) return; if (pressTimer) {{ clearTimeout(pressTimer); pressTimer = null; }} btn.releasePointerCapture(e.pointerId); if (!isLongPress && !isDragging) {{ onClick(); }} }}); btn.addEventListener('contextmenu', e => {{ e.preventDefault(); e.stopPropagation(); }}); }}
        const goPrev = () => renderChapter(currentIndex - 1, isShowingRaw); const goNext = () => renderChapter(currentIndex + 1, isShowingRaw); const goTop = () => window.scrollTo({{ top: 0, behavior: 'smooth' }}); const goBottom = () => window.scrollTo({{ top: document.body.scrollHeight, behavior: 'smooth' }});
        setupHoldButton(els.btnPrev, goPrev, goTop); setupHoldButton(els.btnPrevBtm, goPrev, goTop); setupHoldButton(els.btnNext, goNext, goBottom); setupHoldButton(els.btnNextBtm, goNext, goBottom);
        setupHoldButton(els.btnIndex, toggleIndex, () => {{ const chap = chapters[currentIndex]; if (chap && chap.rawContent) {{ if (isIndexView) toggleIndex(); renderChapter(currentIndex, !isShowingRaw); }} }});
        els.btnTheme.onclick = toggleTheme; els.btnFontInc.onclick = () => changeFontSize(2); els.btnFontDec.onclick = () => changeFontSize(-2);
        const savedTheme = localStorage.getItem('ro_theme'); if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {{ toggleTheme(); }}
        const savedSize = localStorage.getItem('ro_fontsize'); if (savedSize) {{ fontSize = parseInt(savedSize, 10); els.body.style.fontSize = fontSize + 'px'; }}
        const savedProgress = localStorage.getItem('ro_progress_' + BOOK_ID); if (savedProgress) {{ const [idxStr, rawStr] = savedProgress.split('_'); renderChapter(parseInt(idxStr, 10), rawStr === 'true'); }} else {{ renderChapter(0, false); }}
    </script>
</body>
</html>"""
    with open(out_filepath, 'w', encoding='utf-8') as f:
        f.write(template)

def generate_zip(chapters, out_filepath):
    print(f"  [+] Generating ZIP Archive: {os.path.basename(out_filepath)}")
    
    html_template = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.8; max-width: 800px; margin: 0 auto; padding: 30px 20px; color: #111; background-color: #fdfdfd; }}
        p {{ margin-bottom: 1.2em; font-size: 18px; }}
        h1 {{ text-align: center; margin-top: 1em; margin-bottom: 1.5em; padding-bottom: 0.5em; border-bottom: 1px solid #eaeaea; font-size: 28px; }}
        hr {{ border: 0; border-top: 1px solid #eaeaea; margin: 3em 0; }}
        blockquote {{ border-left: 4px solid #d1d5db; padding-left: 1rem; margin-left: 0; color: #4b5563; font-style: italic; }}
        .box {{ border: 1px solid #eaeaea; background-color: #f4f4f5; border-radius: 8px; padding: 16px; margin: 24px 0; }}
        .box p:last-child {{ margin-bottom: 0; }}
        @media (prefers-color-scheme: dark) {{ body {{ background-color: #121212; color: #eee; }} h1 {{ border-bottom: 1px solid #333; }} hr {{ border-top: 1px solid #333; }} blockquote {{ border-left-color: #4b5563; color: #9ca3af; }} .box {{ border-color: #333; background-color: #1f1f1f; }} }}
    </style>
</head>
<body>
    <h1>{title}</h1>
    {content}
</body>
</html>"""

    with zipfile.ZipFile(out_filepath, 'w', zipfile.ZIP_DEFLATED) as zout:
        for chap in chapters:
            title = chap['title']
            safe_fname = sanitize_filename(title)
            
            t_html = html_template.format(title=title, content=chap['content'])
            zout.writestr(f"Translated/{safe_fname}.html", t_html.encode('utf-8'))
            
            if chap.get('rawContent'):
                r_title = f"{title} - Raw"
                safe_r_fname = sanitize_filename(r_title)
                r_html = html_template.format(title=r_title, content=chap['rawContent'])
                zout.writestr(f"Raw/{safe_r_fname}.html", r_html.encode('utf-8'))

def generate_epub(book_title, chapters, out_filepath):
    print(f"  [+] Generating EPUB eBook: {os.path.basename(out_filepath)}")
    book_uuid = "urn:uuid:" + str(uuid.uuid4())
    
    manifest_items = ""
    spine_items = ""
    navmap_items = ""
    play_order = 1

    chap_template = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>{title}</title>
<style>body {{ font-family: sans-serif; line-height: 1.6; padding: 2% 5%; }} h1 {{ text-align: center; margin-bottom: 1.5em; font-size: 1.5em; {color_style} }} p {{ margin-bottom: 1em; }} blockquote {{ border-left: 3px solid #ccc; padding-left: 1em; margin-left: 0; font-style: italic; }} .box {{ border: 1px solid #ccc; background-color: #f9f9f9; border-radius: 6px; padding: 1em; margin: 1.5em 0; }} .box p:last-child {{ margin-bottom: 0; }}</style>
</head>
<body>
<h1>{title}</h1>
{content}
</body>
</html>"""

    with zipfile.ZipFile(out_filepath, 'w') as zout:
        zout.writestr('mimetype', b'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        zout.writestr('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>'.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        for i, chap in enumerate(chapters, 1):
            # Translated
            t_title = escape_xml(chap['title'])
            t_safe_content = chap['content'].replace('<br>', '<br/>').replace('<hr>', '<hr/>')
            t_html = chap_template.format(title=t_title, color_style="", content=t_safe_content)
            
            t_fname = f"chapter_trans_{i:03d}.html"
            t_id = f"chapter_trans_{i:03d}"
            
            zout.writestr(f"OEBPS/Text/{t_fname}", t_html.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
            manifest_items += f'<item id="{t_id}" href="Text/{t_fname}" media-type="application/xhtml+xml"/>\n'
            spine_items += f'<itemref idref="{t_id}"/>\n'
            navmap_items += f'<navPoint id="navPoint-{play_order}" playOrder="{play_order}"><navLabel><text>{t_title}</text></navLabel><content src="Text/{t_fname}"/></navPoint>\n'
            play_order += 1
            
            # Raw
            if chap.get('rawContent'):
                r_title = escape_xml(f"{chap['title']} - Raw")
                r_safe_content = chap['rawContent'].replace('<br>', '<br/>').replace('<hr>', '<hr/>')
                r_html = chap_template.format(title=r_title, color_style="color: #555;", content=r_safe_content)
                
                r_fname = f"chapter_raw_{i:03d}.html"
                r_id = f"chapter_raw_{i:03d}"
                
                zout.writestr(f"OEBPS/Text/{r_fname}", r_html.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
                manifest_items += f'<item id="{r_id}" href="Text/{r_fname}" media-type="application/xhtml+xml"/>\n'
                spine_items += f'<itemref idref="{r_id}"/>\n'
                navmap_items += f'<navPoint id="navPoint-{play_order}" playOrder="{play_order}"><navLabel><text>{r_title}</text></navLabel><content src="Text/{r_fname}"/></navPoint>\n'
                play_order += 1

        opf_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:title>{escape_xml(book_title)}</dc:title>
<dc:language>en</dc:language>
<dc:identifier id="BookId">{book_uuid}</dc:identifier>
</metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
{manifest_items}</manifest>
<spine toc="ncx">
{spine_items}</spine>
</package>'''
        zout.writestr('OEBPS/content.opf', opf_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        ncx_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="{book_uuid}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>{escape_xml(book_title)}</text></docTitle>
<navMap>
{navmap_items}</navMap>
</ncx>'''
        zout.writestr('OEBPS/toc.ncx', ncx_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

# --- MAIN ENGINE ---

def main():
    print("--- ReadOmni Universal Format Converter ---\n")
    if len(sys.argv) < 2:
        print("Usage: python convert_readomni.py <input_file>")
        return
        
    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(f"Error: File '{filepath}' not found.")
        return

    ext = os.path.splitext(filepath)[1].lower()
    
    try:
        if ext == '.html':
            book_title, chapters = extract_from_html(filepath)
        elif ext == '.zip':
            book_title, chapters = extract_from_zip(filepath)
        elif ext == '.epub':
            book_title, chapters = extract_from_epub(filepath)
        else:
            print(f"Error: Unsupported format {ext}. Please provide a .html, .zip, or .epub file.")
            return
    except Exception as e:
        print(f"Extraction failed: {e}")
        return

    if not chapters:
        print("Error: No chapters were found in the source file.")
        return

    print(f"  [*] Successfully extracted {len(chapters)} chapters.")

    out_dir = os.path.join(os.getcwd(), 'converted')
    if not os.path.exists(out_dir):
        os.makedirs(out_dir)

    base_name = os.path.splitext(os.path.basename(filepath))[0]
    
    if ext != '.html':
        generate_html_app(book_title, chapters, os.path.join(out_dir, f"{base_name}.html"))
    if ext != '.zip':
        generate_zip(chapters, os.path.join(out_dir, f"{base_name}.zip"))
    if ext != '.epub':
        generate_epub(book_title, chapters, os.path.join(out_dir, f"{base_name}.epub"))

    print("\n--- Process Completed! Check the 'converted' folder. ---")

if __name__ == '__main__':
    main()