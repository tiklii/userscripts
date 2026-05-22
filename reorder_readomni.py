import os
import re
import json
import zipfile
import uuid
import sys

VERSION = "1.1.0"

# Terminal Colors
C_GREEN = '\033[92m'
C_YELLOW = '\033[93m'
C_RED = '\033[91m'
C_BLUE = '\033[94m'
C_RESET = '\033[0m'

def extract_h1_title(html_content):
    """Extracts the title text from the <h1> tag."""
    match = re.search(r'<h1>(.*?)</h1>', html_content, re.IGNORECASE | re.DOTALL)
    if match:
        # Clean up any HTML tags inside the h1 just in case
        return re.sub(r'<[^>]+>', '', match.group(1)).strip()
    return "Unknown Title"

def update_html_tags(html_content, new_num):
    """Updates the <title>, <h1>, and cross-links with the new sequential number and normalizes suffixes."""
    # Normalize suffixes
    html_content = html_content.replace(' - Raw</title>', ' (Raw)</title>')
    html_content = html_content.replace(' - Raw</h1>', ' (Raw)</h1>')

    # Update <title> tag
    html_content = re.sub(r'<title>\[\d+\]\s*(.*?)</title>', fr'<title>[{new_num:02d}] \1</title>', html_content)
    
    # Update cross-link destinations in combined EPUB
    html_content = re.sub(
        r'(href="(?:Text/)?chapter_(raw|trans)_)(\d+)(\.html")',
        lambda m: f"{m.group(1)}{new_num:03d}{m.group(4)}",
        html_content
    )

    # Update <h1> tag numbering (handles plain h1 and h1 with nested a tags)
    def h1_replace(match):
        h1_inner = match.group(1)
        h1_inner = re.sub(r'\[\d+\]\s*', f'[{new_num:02d}] ', h1_inner, count=1)
        h1_inner = h1_inner.replace(' - Raw', ' (Raw)')
        return f"<h1>{h1_inner}</h1>"

    html_content = re.sub(r'<h1>(.*?)</h1>', h1_replace, html_content, flags=re.DOTALL | re.IGNORECASE)
    return html_content



def parse_zip(filepath):
    """Extracts chapters from a ZIP Archive."""
    chapters = []
    with zipfile.ZipFile(filepath, 'r') as zin:
        namelist = zin.namelist()
        t_files = [x for x in namelist if x.startswith('Translated/') and x.endswith('.html')]
        
        def get_num(fname):
            m = re.search(r'\[(\d+)\]', fname)
            return int(m.group(1)) if m else 999999
            
        t_files.sort(key=get_num)
        r_dict = {get_num(x): x for x in namelist if x.startswith('Raw/') and x.endswith('.html')}
        
        for idx, t in enumerate(t_files):
            num = get_num(t)
            content = zin.read(t).decode('utf-8', 'ignore')
            title = extract_h1_title(content)
            chapters.append({
                'id': idx,
                'title': title,
                't_file': t,
                'r_file': r_dict.get(num)
            })
    return chapters, None

def parse_epub(filepath):
    """Extracts chapters from an EPUB."""
    chapters = []
    with zipfile.ZipFile(filepath, 'r') as zin:
        namelist = zin.namelist()
        t_files = [x for x in namelist if x.startswith('OEBPS/Text/chapter_trans_') and x.endswith('.html')]
        
        def get_epub_num(fname):
            m = re.search(r'_trans_(\d+)', fname)
            return int(m.group(1)) if m else 999999
            
        t_files.sort(key=get_epub_num)
        for idx, t in enumerate(t_files):
            num_str = re.search(r'_trans_(\d+)', t).group(1)
            r_file = f'OEBPS/Text/chapter_raw_{num_str}.html'
            if r_file not in namelist:
                r_file = None
                
            content = zin.read(t).decode('utf-8', 'ignore')
            title = extract_h1_title(content)
            
            chapters.append({
                'id': idx,
                'title': title,
                't_file': t,
                'r_file': r_file
            })
    return chapters, None

def generate_plan_file(chapters, plan_path):
    """Generates the text file for the user to edit."""
    with open(plan_path, 'w', encoding='utf-8') as f:
        f.write("# =====================================================================\n")
        f.write("# READOMNI CHAPTER REORDER PLAN\n")
        f.write("# =====================================================================\n")
        f.write("# INSTRUCTIONS:\n")
        f.write("# 1. Rearrange the lines below to reorder your chapters.\n")
        f.write("# 2. Do NOT change the 'ID:XXXX' part. That is how the script identifies the files.\n")
        f.write("# 3. You can delete lines to completely remove those chapters.\n")
        f.write("# 4. Save this file, then return to the terminal and press ENTER.\n")
        f.write("# =====================================================================\n\n")
        
        for chap in chapters:
            f.write(f"ID:{chap['id']:04d} | {chap['title']}\n")

def read_plan_file(plan_path, original_chapters):
    """Reads the user-edited text file and returns the new ordered list."""
    new_order = []
    original_dict = {chap['id']: chap for chap in original_chapters}
    
    if not os.path.exists(plan_path):
        return None
        
    with open(plan_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
                
            match = re.search(r'ID:(\d+)', line)
            if match:
                chap_id = int(match.group(1))
                if chap_id in original_dict:
                    new_order.append(original_dict[chap_id])
                    
    return new_order



def rebuild_zip(new_chapters, in_filepath, out_filepath):
    print(f"  {C_BLUE}[*] Rebuilding ZIP Archive...{C_RESET}")
    copied_assets = set()
    
    with zipfile.ZipFile(in_filepath, 'r') as zin, zipfile.ZipFile(out_filepath, 'w', zipfile.ZIP_DEFLATED) as zout:
        # Copy non-chapter assets
        for item in zin.namelist():
            if ('Translated/' in item and item.endswith('.html')) or ('Raw/' in item and item.endswith('.html')):
                continue
            zout.writestr(zin.getinfo(item), zin.read(item))
            copied_assets.add(item)
            
        # Write reordered chapters
        for idx, chap in enumerate(new_chapters, start=1):
            t_content = update_html_tags(zin.read(chap['t_file']).decode('utf-8', 'ignore'), idx)
            new_t_name = re.sub(r'\[\d+\]\s*', f'[{idx:02d}] ', chap['t_file'], count=1)
            zout.writestr(new_t_name, t_content.encode('utf-8'))
            
            if chap['r_file']:
                r_content = update_html_tags(zin.read(chap['r_file']).decode('utf-8', 'ignore'), idx)
                new_r_name = re.sub(r'\[\d+\]\s*', f'[{idx:02d}] ', chap['r_file'], count=1)
                new_r_name = new_r_name.replace(' - Raw.html', ' (Raw).html')
                zout.writestr(new_r_name, r_content.encode('utf-8'))

def rebuild_epub(new_chapters, in_filepath, out_filepath):
    print(f"  {C_BLUE}[*] Rebuilding EPUB (Preserving CSS/Covers)...{C_RESET}")
    
    base_metadata = "<metadata></metadata>"
    preserved_manifest = set()
    preserved_spine = []
    copied_assets = set()

    with zipfile.ZipFile(in_filepath, 'r') as zin:
        namelist = zin.namelist()
        opf_path = next((f for f in namelist if f.endswith('.opf')), 'OEBPS/content.opf')
        if opf_path in namelist:
            opf_content = zin.read(opf_path).decode('utf-8', 'ignore')
            
            m_match = re.search(r'<[a-zA-Z0-9:]*metadata[^>]*>.*?</[a-zA-Z0-9:]*metadata>', opf_content, re.DOTALL | re.IGNORECASE)
            if m_match: base_metadata = m_match.group(0)
            
            s_match = re.search(r'<[a-zA-Z0-9:]*spine([^>]*)>(.*?)</[a-zA-Z0-9:]*spine>', opf_content, re.DOTALL | re.IGNORECASE)
            if s_match:
                for item in re.findall(r'<[a-zA-Z0-9:]*itemref [^>]+/>', s_match.group(2), re.IGNORECASE):
                    if 'chapter_trans_' not in item and 'chapter_raw_' not in item:
                        preserved_spine.append(item)
        
            man_match = re.search(r'<[a-zA-Z0-9:]*manifest>(.*?)</[a-zA-Z0-9:]*manifest>', opf_content, re.DOTALL | re.IGNORECASE)
            if man_match:
                for item in re.findall(r'<[a-zA-Z0-9:]*item [^>]+/>', man_match.group(1), re.IGNORECASE):
                    if 'chapter_trans_' not in item and 'chapter_raw_' not in item and 'toc.ncx' not in item:
                        preserved_manifest.add(item)

    book_uuid = "urn:uuid:" + str(uuid.uuid4())
    base_metadata = re.sub(r'<dc:identifier id="BookId">.*?</dc:identifier>', f'<dc:identifier id="BookId">{book_uuid}</dc:identifier>', base_metadata)
    
    title_match = re.search(r'<dc:title>(.*?)</dc:title>', base_metadata)
    book_title = title_match.group(1) + " (Reordered)" if title_match else "Reordered ReadOmni Book"

    manifest_items = ""
    spine_items = ""
    navmap_items = ""
    play_order = 1

    with zipfile.ZipFile(in_filepath, 'r') as zin, zipfile.ZipFile(out_filepath, 'w') as zout:
        zout.writestr('mimetype', b'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        container_xml = '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>'
        zout.writestr('META-INF/container.xml', container_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        for item in zin.namelist():
            if item in copied_assets: continue
            if ('chapter_trans_' in item or 'chapter_raw_' in item or 
                item.endswith('.opf') or item.endswith('.ncx') or 
                item == 'mimetype' or item == 'META-INF/container.xml'):
                continue
            zout.writestr(zin.getinfo(item), zin.read(item))
            copied_assets.add(item)

        written_translated = []
        written_raw = []

        for idx, chap in enumerate(new_chapters, start=1):
            # Process Translated
            t_content = update_html_tags(zin.read(chap['t_file']).decode('utf-8', 'ignore'), idx)
            t_title = extract_h1_title(t_content)
            new_t_filename = f'chapter_trans_{idx:03d}.html'
            new_t_id = f'chapter_trans_{idx:03d}'
            
            zout.writestr(f'OEBPS/Text/{new_t_filename}', t_content.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
            manifest_items += f'<item id="{new_t_id}" href="Text/{new_t_filename}" media-type="application/xhtml+xml"/>\n'
            spine_items += f'<itemref idref="{new_t_id}"/>\n'
            written_translated.append((new_t_filename, t_title))
            
            # Process Raw
            if chap['r_file']:
                r_content = update_html_tags(zin.read(chap['r_file']).decode('utf-8', 'ignore'), idx)
                r_title = extract_h1_title(r_content)
                new_r_filename = f'chapter_raw_{idx:03d}.html'
                new_r_id = f'chapter_raw_{idx:03d}'
                
                zout.writestr(f'OEBPS/Text/{new_r_filename}', r_content.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
                manifest_items += f'<item id="{new_r_id}" href="Text/{new_r_filename}" media-type="application/xhtml+xml"/>\n'
                spine_items += f'<itemref idref="{new_r_id}"/>\n'
                written_raw.append((new_r_filename, r_title))

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
{base_metadata}
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
{chr(10).join(preserved_manifest)}
{manifest_items}</manifest>
<spine toc="ncx">
{chr(10).join(preserved_spine)}
{spine_items}</spine>
</package>'''
        zout.writestr('OEBPS/content.opf', opf_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        ncx_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="{book_uuid}"/><meta name="dtb:depth" content="2"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>{book_title}</text></docTitle>
<navMap>
{navmap_items}</navMap>
</ncx>'''
        zout.writestr('OEBPS/toc.ncx', ncx_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

def main():
    if len(sys.argv) < 2 or sys.argv[1] in ['-h', '--help']:
        print(f"""
{C_BLUE}======================================================
    ReadOmni Chapter Reorder Tool - v{VERSION}
======================================================{C_RESET}
Usage: python reorder_readomni.py <target_file>

Supports .zip and .epub files.

How it works:
  1. The script reads your file and generates a 'reorder_plan.txt'.
  2. You open 'reorder_plan.txt' and cut/paste the lines to 
     rearrange the chapters easily.
  3. You save the text file, press ENTER in the terminal, and 
     the script builds a perfectly re-numbered output file!
        """)
        sys.exit(0)

    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(f"{C_RED}[!] Error: File '{filepath}' not found.{C_RESET}")
        sys.exit(1)

    ext = os.path.splitext(filepath)[1].lower()
    base_name = os.path.splitext(os.path.basename(filepath))[0]
    out_dir = os.path.join(os.getcwd(), 'reordered')
    out_filepath = os.path.join(out_dir, f"{base_name}_Reordered{ext}")
    plan_path = os.path.join(os.getcwd(), f"{base_name}_reorder_plan.txt")

    print(f"\n{C_BLUE}[*] Reading original file: {filepath}{C_RESET}")
    
    try:
        if ext == '.zip':
            chapters, base_content = parse_zip(filepath)
        elif ext == '.epub':
            chapters, base_content = parse_epub(filepath)
        else:
            print(f"{C_RED}[!] Unsupported format: {ext}{C_RESET}")
            sys.exit(1)
    except Exception as e:
        print(f"{C_RED}[!] Failed to parse file: {e}{C_RESET}")
        sys.exit(1)

    if not chapters:
        print(f"{C_YELLOW}[!] No chapters found inside the file.{C_RESET}")
        sys.exit(0)

    # 1. Generate Plan
    generate_plan_file(chapters, plan_path)
    
    print(f"\n{C_GREEN}============================================================{C_RESET}")
    print(f"{C_YELLOW} ACTION REQUIRED:{C_RESET}")
    print(f" 1. Open the newly created file: {C_BLUE}{plan_path}{C_RESET}")
    print(f" 2. Rearrange the lines in any text editor to reorder chapters.")
    print(f"    (You can also delete lines to completely remove chapters).")
    print(f" 3. Save the file.")
    print(f"{C_GREEN}============================================================{C_RESET}\n")
    
    input(f"{C_YELLOW}Press ENTER here when you have saved the text file...{C_RESET}")
    
    # 2. Read Edited Plan
    new_chapters = read_plan_file(plan_path, chapters)
    if not new_chapters:
        print(f"{C_RED}[!] Error reading plan file or plan file is empty. Aborting.{C_RESET}")
        sys.exit(1)

    if not os.path.exists(out_dir):
        os.makedirs(out_dir)

    # 3. Rebuild
    print(f"\n{C_BLUE}[*] Processing new order ({len(new_chapters)} chapters)...{C_RESET}")
    
    if ext == '.zip':
        rebuild_zip(new_chapters, filepath, out_filepath)
    elif ext == '.epub':
        rebuild_epub(new_chapters, filepath, out_filepath)

    # Clean up the plan file to keep the directory tidy
    if os.path.exists(plan_path):
        os.remove(plan_path)

    print(f"\n{C_GREEN}--- Success! Check the 'reordered' folder. ---{C_RESET}")
    print(f"Saved: {out_filepath}")

if __name__ == '__main__':
    main()