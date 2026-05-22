import os
import re
import json
import zipfile
import uuid
import sys

VERSION = "2.2.0"

# Terminal Colors
C_GREEN = '\033[92m'
C_YELLOW = '\033[93m'
C_RED = '\033[91m'
C_BLUE = '\033[94m'
C_RESET = '\033[0m'

def natural_sort_key(s):
    """Splits strings into text and numbers to sort them mathematically (Natural Sort)."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]

def get_chapter_num(html_content, fallback_str=None):
    """Strictly extracts the integer chapter number from titles to avoid false text matches."""
    # 1. Check <h1>
    m = re.search(r'<h1>(.*?)</h1>', html_content, re.IGNORECASE | re.DOTALL)
    if m:
        m2 = re.search(r"\b(?:chapter|ch|chp)\.?\s*(\d+)", m.group(1), re.IGNORECASE)
        if m2: return int(m2.group(1))

    # 2. Check <title>
    m = re.search(r'<title>(.*?)</title>', html_content, re.IGNORECASE | re.DOTALL)
    if m:
        m2 = re.search(r"\b(?:chapter|ch|chp)\.?\s*(\d+)", m.group(1), re.IGNORECASE)
        if m2: return int(m2.group(1))

    # 3. Check filename fallback
    if fallback_str:
        m2 = re.search(r"\b(?:chapter|ch|chp)\.?\s*(\d+)", fallback_str, re.IGNORECASE)
        if m2: return int(m2.group(1))

    return None

def clean_content_for_compare(html):
    """Strips all HTML tags, prefixes, and whitespace for strict duplicate text checking."""
    html = re.sub(r'<title>\[\d+\]\s*', '<title>', html)
    html = re.sub(r'<h1>\[\d+\]\s*', '<h1>', html)
    text = re.sub(r'<[^>]+>', '', html)
    return re.sub(r'\s+', '', text)

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

def extract_h1_title(html_content):
    """Extracts the title text from the <h1> tag for EPUB TOC generation."""
    match = re.search(r'<h1>(.*?)</h1>', html_content)
    return match.group(1) if match else "Unknown Title"

def combine_plans(plans, mode, repeat_allow):
    """Combines extracted chapter plans based on the selected mode."""
    if mode == 'directory' or mode == 'append':
        final_plan = []
        for p in plans:
            final_plan.extend(p)
        return final_plan

    elif mode == 'in-between':
        p1, p2 = plans[0], plans[1]
        max_idx = len(p1)
        print(f"\n{C_BLUE}[?] File A has {max_idx} chapters. File B has {len(p2)} chapters.{C_RESET}")
        while True:
            try:
                ans = input(f"    Insert File B AFTER which chapter of File A? (0 to insert at the beginning, {max_idx} to append at the end): ")
                idx = int(ans)
                if 0 <= idx <= max_idx:
                    return p1[:idx] + p2 + p1[idx:]
                print(f"    {C_RED}[!] Index out of range. Please try again.{C_RESET}")
            except ValueError:
                print(f"    {C_RED}[!] Please enter a valid number.{C_RESET}")

    elif mode == 'insert':
        planA, planB = plans[0], plans[1]

        print(f"  {C_BLUE}[*] Analyzing structural chapter numbers in both files...{C_RESET}")

        # Pre-compute chapter numbers and titles
        for item in planA:
            content = item['get_content']()
            item['title'] = extract_h1_title(content)
            item['num'] = get_chapter_num(content, item.get('t_file'))

        for item in planB:
            content = item['get_content']()
            item['title'] = extract_h1_title(content)
            item['num'] = get_chapter_num(content, item.get('t_file'))

        dictA = {}
        for item in planA:
            if item['num'] is not None:
                dictA.setdefault(item['num'], []).append(item)

        items_to_insert = []
        for itemB in planB:
            num = itemB['num']
            if num is None:
                print(f"  {C_YELLOW}[?] Skipping File B chapter '{itemB['title']}' (Could not detect 'Chapter X' number).{C_RESET}")
                continue

            if num in dictA:
                if repeat_allow:
                    contentB = clean_content_for_compare(itemB['get_content']())
                    is_dup = False
                    for itemA in dictA[num]:
                        contentA = clean_content_for_compare(itemA['get_content']())
                        if contentA == contentB:
                            is_dup = True
                            break
                    if not is_dup:
                        items_to_insert.append(itemB)
                    else:
                        print(f"  {C_YELLOW}[-] Skipping '{itemB['title']}' (Exact duplicate found in File A).{C_RESET}")
                else:
                    print(f"  {C_YELLOW}[-] Skipping '{itemB['title']}' (Chapter {num} already exists in File A).{C_RESET}")
            else:
                items_to_insert.append(itemB)

        # Sort items_to_insert by chapter number just in case File B is out of order
        items_to_insert.sort(key=lambda x: x['num'])

        for itemB in items_to_insert:
            numB = itemB['num']

            # Find insertion index: first item in planA with a num > numB
            insert_idx = len(planA)
            for i, itemA in enumerate(planA):
                if itemA['num'] is not None and itemA['num'] > numB:
                    insert_idx = i
                    break

            print(f"\n  {C_GREEN}[+] Inserting: {itemB['title']}{C_RESET}")
            print(f"      {C_BLUE}--- Context ---{C_RESET}")

            # Show 2 chapters before
            start_idx = max(0, insert_idx - 2)
            for i in range(start_idx, insert_idx):
                print(f"      {planA[i]['title']}")

            # Show the inserted item
            print(f"    {C_GREEN}> {itemB['title']} <{C_RESET}")

            # Show 2 chapters after
            end_idx = min(len(planA), insert_idx + 2)
            for i in range(insert_idx, end_idx):
                print(f"      {planA[i]['title']}")

            print(f"      {C_BLUE}---------------{C_RESET}")

            # Perform the insertion
            planA.insert(insert_idx, itemB)

        return planA


    print(f"\n{C_BLUE}[*] Processing {len(files)} ZIP Archive(s)...{C_RESET}")
    open_zips = {f: zipfile.ZipFile(f, 'r') for f in set(files)}
    plans = []

    for filepath in files:
        plan = []
        zin = open_zips[filepath]
        namelist = zin.namelist()
        t_files = [x for x in namelist if x.startswith('Translated/') and x.endswith('.html')]

        def get_num(fname):
            m = re.search(r'\[(\d+)\]', fname)
            return int(m.group(1)) if m else 999999

        t_files.sort(key=get_num)
        r_dict = {get_num(x): x for x in namelist if x.startswith('Raw/') and x.endswith('.html')}

        for t in t_files:
            num = get_num(t)
            r = r_dict.get(num)
            plan.append({
                'fp': filepath,
                't_file': t,
                'r_file': r,
                'get_content': lambda f=filepath, tf=t: open_zips[f].read(tf).decode('utf-8', 'ignore')
            })
        plans.append(plan)

    final_plan = combine_plans(plans, mode, repeat_allow)
    if not final_plan:
        for z in open_zips.values(): z.close()
        return

    print(f"\n  {C_GREEN}[+] Rebuilding merged ZIP (Preserving non-chapter assets)...{C_RESET}")
    copied_assets = set()

    with zipfile.ZipFile(out_filepath, 'w', zipfile.ZIP_DEFLATED) as zout:
        for filepath in files:
            zin = open_zips[filepath]
            for item in zin.namelist():
                if item in copied_assets: continue
                if ('Translated/' in item and item.endswith('.html')) or ('Raw/' in item and item.endswith('.html')):
                    continue
                zout.writestr(zin.getinfo(item), zin.read(item))
                copied_assets.add(item)

        for global_idx, item in enumerate(final_plan, 1):
            zin = open_zips[item['fp']]

            t_content = update_html_tags(zin.read(item['t_file']).decode('utf-8', 'ignore'), global_idx)
            new_t_name = re.sub(r'\[\d+\]\s*', f'[{global_idx:02d}] ', item['t_file'], count=1)
            zout.writestr(new_t_name, t_content.encode('utf-8'))

            if item['r_file']:
                r_content = update_html_tags(zin.read(item['r_file']).decode('utf-8', 'ignore'), global_idx)
                new_r_name = re.sub(r'\[\d+\]\s*', f'[{global_idx:02d}] ', item['r_file'], count=1)
                new_r_name = new_r_name.replace(' - Raw.html', ' (Raw).html')
                zout.writestr(new_r_name, r_content.encode('utf-8'))

    for z in open_zips.values(): z.close()
    print(f"  {C_GREEN}[+] Saved to: {out_filepath}{C_RESET}")

def handle_epubs(files, mode, out_filepath, repeat_allow):
    print(f"\n{C_BLUE}[*] Processing {len(files)} EPUB eBook(s)...{C_RESET}")
    open_zips = {f: zipfile.ZipFile(f, 'r') for f in set(files)}
    plans = []

    base_metadata = "<metadata></metadata>"
    preserved_manifest = set()
    preserved_spine = []
    copied_assets = set()

    for idx, filepath in enumerate(files):
        plan = []
        zin = open_zips[filepath]
        namelist = zin.namelist()

        opf_path = next((f for f in namelist if f.endswith('.opf')), 'OEBPS/content.opf')
        if opf_path in namelist:
            opf_content = zin.read(opf_path).decode('utf-8', 'ignore')

            if idx == 0:
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

        t_files = [x for x in namelist if x.startswith('OEBPS/Text/chapter_trans_') and x.endswith('.html')]

        def get_epub_num(fname):
            m = re.search(r'_trans_(\d+)', fname)
            return int(m.group(1)) if m else 999999

        t_files.sort(key=get_epub_num)
        for t in t_files:
            num_str = re.search(r'_trans_(\d+)', t).group(1)
            r_file = f'OEBPS/Text/chapter_raw_{num_str}.html'
            if r_file not in namelist: r_file = None
            plan.append({
                'fp': filepath,
                't_file': t,
                'r_file': r_file,
                'get_content': lambda f=filepath, tf=t: open_zips[f].read(tf).decode('utf-8', 'ignore')
            })
        plans.append(plan)

    final_plan = combine_plans(plans, mode, repeat_allow)
    if not final_plan:
        for z in open_zips.values(): z.close()
        return

    book_uuid = "urn:uuid:" + str(uuid.uuid4())
    base_metadata = re.sub(r'<dc:identifier id="BookId">.*?</dc:identifier>', f'<dc:identifier id="BookId">{book_uuid}</dc:identifier>', base_metadata)

    title_match = re.search(r'<dc:title>(.*?)</dc:title>', base_metadata)
    book_title = title_match.group(1) + " (Merged)" if title_match else "Merged ReadOmni Book"

    print(f"\n  {C_GREEN}[+] Rebuilding merged EPUB (Preserving Covers, CSS, and Title Pages)...{C_RESET}")

    manifest_items = ""
    spine_items = ""
    navmap_items = ""
    play_order = 1

    with zipfile.ZipFile(out_filepath, 'w') as zout:
        zout.writestr('mimetype', b'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        container_xml = '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>'
        zout.writestr('META-INF/container.xml', container_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        for filepath in files:
            zin = open_zips[filepath]
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

        for global_idx, item in enumerate(final_plan, 1):
            zin = open_zips[item['fp']]

            # Process Translated
            t_content = update_html_tags(zin.read(item['t_file']).decode('utf-8', 'ignore'), global_idx)
            t_title = extract_h1_title(t_content)
            new_t_filename = f'chapter_trans_{global_idx:03d}.html'
            new_t_id = f'chapter_trans_{global_idx:03d}'

            zout.writestr(f'OEBPS/Text/{new_t_filename}', t_content.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
            manifest_items += f'<item id="{new_t_id}" href="Text/{new_t_filename}" media-type="application/xhtml+xml"/>\n'
            spine_items += f'<itemref idref="{new_t_id}"/>\n'
            written_translated.append((new_t_filename, t_title))

            # Process Raw
            if item['r_file']:
                r_content = update_html_tags(zin.read(item['r_file']).decode('utf-8', 'ignore'), global_idx)
                r_title = extract_h1_title(r_content)
                new_r_filename = f'chapter_raw_{global_idx:03d}.html'
                new_r_id = f'chapter_raw_{global_idx:03d}'

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

    for z in open_zips.values(): z.close()
    print(f"  {C_GREEN}[+] Saved to: {out_filepath}{C_RESET}")

def print_help():
    print(f"""
{C_BLUE}======================================================
     ReadOmni Auto-Merger - Version {VERSION}
======================================================{C_RESET}

Description:
  This tool seamlessly merges ReadOmni downloaded files (.zip archives and .epub eBooks).
  It concatenates their contents, entirely recalculates the [XX] numbering sequence,
  rebuilds internal tables/TOCs, and automatically preserves Calibre cover images,
  fonts, and stylesheets!

{C_YELLOW}Usage Modes:{C_RESET}

  {C_GREEN}1. Directory Merge Mode (--dir){C_RESET}
     Automatically scans the current folder, groups files by extension, sorts them
     using natural logic (e.g., File2 comes before File10), and merges them.

     Command:
       python merge_readomni.py --dir

  {C_GREEN}2. Append Mode{C_RESET}
     Explicitly merges exactly two files together by appending File B to the end of File A.

     Command:
       python merge_readomni.py <fileA> <fileB>
     Example:
       python merge_readomni.py "Book_Part1.epub" "Book_Part2.epub"

  {C_GREEN}3. In-Between Mode (--in-between){C_RESET}
     Interactively inserts the contents of File B *inside* File A at a specific chapter point.

     Command:
       python merge_readomni.py --in-between <fileA> <fileB>

  {C_GREEN}4. Smart Insert Mode (--insert){C_RESET}
     Scans the internal text of File A and File B to detect 'Chapter X' numbers.
     It then automatically injects chapters from File B into File A at the correct locations.
     If a chapter already exists in File A, it safely skips it to prevent duplicates!

     Command:
       python merge_readomni.py --insert <fileA> <fileB>

     Optional Flag:
       --repeat-allow   (If passed, allows inserting a duplicate chapter number IF
                         the actual story text inside is different from File A).

Outputs:
  All merged files are safely placed into a new folder named 'merged' in the current directory.
  Your original files are never altered or deleted.
""")

def main():
    args = sys.argv[1:]

    if len(args) == 0 or '-h' in args or '--help' in args:
        print_help()
        sys.exit(0)

    print(f"{C_BLUE}--- ReadOmni Advanced Merger v{VERSION} ---{C_RESET}\n")

    repeat_allow = False
    if '--repeat-allow' in args:
        repeat_allow = True
        args.remove('--repeat-allow')

    mode = None
    files_to_process = []

    if args[0] == '--dir':
        mode = 'directory'
    elif args[0] == '--in-between' and len(args) == 3:
        mode = 'in-between'
        files_to_process = [args[1], args[2]]
    elif args[0] == '--insert' and len(args) == 3:
        mode = 'insert'
        files_to_process = [args[1], args[2]]
    elif len(args) == 2 and not args[0].startswith('--'):
        mode = 'append'
        files_to_process = [args[0], args[1]]
    else:
        print(f"{C_RED}Invalid arguments provided. Run 'python merge_readomni.py' for help.{C_RESET}")
        sys.exit(1)

    out_dir = os.path.join(os.getcwd(), 'merged')
    if not os.path.exists(out_dir):
        os.makedirs(out_dir)

    if mode == 'directory':
        print("Note: All files will be joined in natural sequential order.\n")
        files = [f for f in os.listdir(os.getcwd()) if os.path.isfile(f)]
        zip_files = sorted([f for f in files if f.endswith('.zip')], key=natural_sort_key)
        epub_files = sorted([f for f in files if f.endswith('.epub')], key=natural_sort_key)

        if not (zip_files or epub_files):
            print(f"{C_YELLOW}No valid ReadOmni files found in the current directory.{C_RESET}")
            sys.exit(0)

        if len(zip_files) > 1:
            if input(f"Found {len(zip_files)} ZIP files. Merge them? (y/n): ").strip().lower() == 'y':
                handle_zips(zip_files, mode, os.path.join(out_dir, "Merged_Archive.zip"), repeat_allow)
        if len(epub_files) > 1:
            if input(f"Found {len(epub_files)} EPUB files. Merge them? (y/n): ").strip().lower() == 'y':
                handle_epubs(epub_files, mode, os.path.join(out_dir, "Merged_eBook.epub"), repeat_allow)

    else:
        for f in files_to_process:
            if not os.path.exists(f):
                print(f"{C_RED}Error: File not found -> {f}{C_RESET}")
                sys.exit(1)

        ext1 = os.path.splitext(files_to_process[0])[1].lower()
        ext2 = os.path.splitext(files_to_process[1])[1].lower()

        if ext1 != ext2:
            print(f"{C_RED}Error: Files must be of the exact same type ({ext1} vs {ext2}).{C_RESET}")
            sys.exit(1)

        base_name = os.path.splitext(os.path.basename(files_to_process[0]))[0]
        out_filepath = os.path.join(out_dir, f"{base_name}_Merged{ext1}")

        if ext1 == '.zip':
            handle_zips(files_to_process, mode, out_filepath, repeat_allow)
        elif ext1 == '.epub':
            handle_epubs(files_to_process, mode, out_filepath, repeat_allow)
        else:
            print(f"{C_RED}Error: Unsupported file format {ext1}. Use .zip or .epub{C_RESET}")

    print(f"\n{C_BLUE}--- Process Completed! Check the 'merged' folder. ---{C_RESET}")

if __name__ == '__main__':
    main()
