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
                r_title = f"{title} (Raw)"
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
<h1>{h1_content}</h1>
{content}
</body>
</html>"""

    with zipfile.ZipFile(out_filepath, 'w') as zout:
        zout.writestr('mimetype', b'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        zout.writestr('META-INF/container.xml', """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>""".encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        written_translated = []
        written_raw = []

        for i, chap in enumerate(chapters, 1):
            # Translated
            t_title = escape_xml(chap['title'])
            t_safe_content = chap['content'].replace('<br>', '<br/>').replace('<hr>', '<hr/>')
            
            # If combined mode, link heading to raw chapter
            if chap.get('rawContent'):
                t_h1 = f'<a href="chapter_raw_{i:03d}.html" title="Jump to Raw">{t_title}</a>'
            else:
                t_h1 = t_title
                
            t_html = chap_template.format(title=t_title, h1_content=t_h1, color_style="", content=t_safe_content)
            
            t_fname = f"chapter_trans_{i:03d}.html"
            t_id = f"chapter_trans_{i:03d}"
            
            zout.writestr(f"OEBPS/Text/{t_fname}", t_html.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
            manifest_items += f'<item id="{t_id}" href="Text/{t_fname}" media-type="application/xhtml+xml"/>\n'
            spine_items += f'<itemref idref="{t_id}"/>\n'
            written_translated.append((t_fname, t_title))
            
            # Raw
            if chap.get('rawContent'):
                r_title = escape_xml(f"{chap['title']} (Raw)")
                r_safe_content = chap.get('rawContent').replace('<br>', '<br/>').replace('<hr>', '<hr/>')
                
                # Link raw heading back to translated chapter
                r_h1 = f'<a href="chapter_trans_{i:03d}.html" title="Jump to Translated">{r_title}</a>'
                r_html = chap_template.format(title=r_title, h1_content=r_h1, color_style="color: #555;", content=r_safe_content)
                
                r_fname = f"chapter_raw_{i:03d}.html"
                r_id = f"chapter_raw_{i:03d}"
                
                zout.writestr(f"OEBPS/Text/{r_fname}", r_html.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
                manifest_items += f'<item id="{r_id}" href="Text/{r_fname}" media-type="application/xhtml+xml"/>\n'
                spine_items += f'<itemref idref="{r_id}"/>\n'
                written_raw.append((r_fname, r_title))

        if written_translated:
            first_t_filename, _ = written_translated[0]
            navmap_items += f'<navPoint id="navGroup-tl" playOrder="{play_order}">\n<navLabel><text>Translated</text></navLabel>\n<content src="Text/{first_t_filename}"/>\n'
            play_order += 1
            for t_filename, t_title in written_translated:
                navmap_items += f'<navPoint id="navPoint-tl-{play_order}" playOrder="{play_order}"><navLabel><text>{t_title}</text></navLabel><content src="Text/{t_filename}"/></navPoint>\n'
                play_order += 1
            navmap_items += '</navPoint>\n'

        if written_raw:
            first_r_filename, _ = written_raw[0]
            navmap_items += f'<navPoint id="navGroup-raw" playOrder="{play_order}">\n<navLabel><text>Raw</text></navLabel>\n<content src="Text/{first_r_filename}"/>\n'
            play_order += 1
            for r_filename, r_title in written_raw:
                navmap_items += f'<navPoint id="navPoint-raw-{play_order}" playOrder="{play_order}"><navLabel><text>{r_title}</text></navLabel><content src="Text/{r_filename}"/></navPoint>\n'
                play_order += 1
            navmap_items += '</navPoint>\n'

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
<head><meta name="dtb:uid" content="{book_uuid}"/><meta name="dtb:depth" content="2"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
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
    
    if ext != '.zip':
        generate_zip(chapters, os.path.join(out_dir, f"{base_name}.zip"))
    if ext != '.epub':
        generate_epub(book_title, chapters, os.path.join(out_dir, f"{base_name}.epub"))

    print("\n--- Process Completed! Check the 'converted' folder. ---")

if __name__ == '__main__':
    main()