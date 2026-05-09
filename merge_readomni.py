import os
import re
import json
import zipfile
import uuid
import sys

def natural_sort_key(s):
    """Splits strings into text and numbers to sort them mathematically (Natural Sort)."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]

def update_html_tags(html_content, new_num):
    """Updates the <title> and <h1> tags with the new sequential [XX] number."""
    html_content = re.sub(r'<title>\[\d+\](.*?)</title>', fr'<title>[{new_num:02d}]\1</title>', html_content)
    html_content = re.sub(r'<h1>\[\d+\](.*?)</h1>', fr'<h1>[{new_num:02d}]\1</h1>', html_content)
    return html_content

def extract_h1_title(html_content):
    """Extracts the title text from the <h1> tag for EPUB TOC generation."""
    match = re.search(r'<h1>(.*?)</h1>', html_content)
    return match.group(1) if match else "Unknown Title"

def combine_plans(plans, mode):
    """Combines extracted chapter plans based on the selected mode."""
    if mode == 'directory' or mode == 'append':
        final_plan = []
        for p in plans:
            final_plan.extend(p)
        return final_plan
    elif mode == 'in-between':
        p1, p2 = plans[0], plans[1]
        max_idx = len(p1)
        print(f"\n[?] File 1 has {max_idx} chapters. File 2 has {len(p2)} chapters.")
        while True:
            try:
                ans = input(f"    Insert File 2 AFTER which chapter of File 1? (0 to insert at the beginning, {max_idx} to append at the end): ")
                idx = int(ans)
                if 0 <= idx <= max_idx:
                    return p1[:idx] + p2 + p1[idx:]
                print("    [!] Index out of range. Please try again.")
            except ValueError:
                print("    [!] Please enter a valid number.")

def handle_htmls(files, mode, out_filepath):
    print(f"\n[*] Processing {len(files)} Webnovel App HTML(s)...")
    plans = []
    base_content = None

    for i, filepath in enumerate(files):
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
            if i == 0:
                base_content = content
            match = re.search(r'const chapters = (\[.*?\]);\s*const BOOK_ID', content, re.DOTALL)
            if match:
                try:
                    plans.append(json.loads(match.group(1)))
                except json.JSONDecodeError:
                    print(f"  [!] Failed to parse JSON in {filepath}")
                    plans.append([])
            else:
                plans.append([])

    final_plan = combine_plans(plans, mode)
    if not final_plan:
        print("  [-] No chapters to merge.")
        return

    print("  [+] Merging and sequentially renumbering titles...")
    for idx, chap in enumerate(final_plan, start=1):
        chap['title'] = re.sub(r'^\[\d+\]', f'[{idx:02d}]', chap.get('title', ''))

    match = re.search(r'(const chapters = )(\[.*?\])(;\s*const BOOK_ID)', base_content, re.DOTALL)
    new_json_str = json.dumps(final_plan, ensure_ascii=False).replace('</', '<\\/')
    new_content = base_content[:match.start(2)] + new_json_str + base_content[match.end(2):]

    with open(out_filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f"  [+] Saved to: {out_filepath}")

def handle_zips(files, mode, out_filepath):
    print(f"\n[*] Processing {len(files)} ZIP Archive(s)...")
    plans = []

    for filepath in files:
        plan = []
        with zipfile.ZipFile(filepath, 'r') as zin:
            namelist = zin.namelist()
            t_files = [x for x in namelist if x.startswith('Translated/') and x.endswith('.html')]
            
            def get_num(fname):
                m = re.search(r'\[(\d+)\]', fname)
                return int(m.group(1)) if m else 999999
                
            t_files.sort(key=get_num)
            r_dict = {get_num(x): x for x in namelist if x.startswith('Raw/') and x.endswith('.html')}
            
            for t in t_files:
                num = get_num(t)
                plan.append((filepath, t, r_dict.get(num)))
        plans.append(plan)

    final_plan = combine_plans(plans, mode)
    if not final_plan: return

    print("  [+] Rebuilding merged ZIP...")
    open_zips = {f: zipfile.ZipFile(f, 'r') for f in set(files)}
    
    with zipfile.ZipFile(out_filepath, 'w', zipfile.ZIP_DEFLATED) as zout:
        for global_idx, (fp, t_file, r_file) in enumerate(final_plan, 1):
            zin = open_zips[fp]
            
            t_content = update_html_tags(zin.read(t_file).decode('utf-8', 'ignore'), global_idx)
            new_t_name = re.sub(r'\[\d+\]', f'[{global_idx:02d}]', t_file, count=1)
            zout.writestr(new_t_name, t_content.encode('utf-8'))
            
            if r_file:
                r_content = update_html_tags(zin.read(r_file).decode('utf-8', 'ignore'), global_idx)
                new_r_name = re.sub(r'\[\d+\]', f'[{global_idx:02d}]', r_file, count=1)
                zout.writestr(new_r_name, r_content.encode('utf-8'))

    for z in open_zips.values(): z.close()
    print(f"  [+] Saved to: {out_filepath}")

def handle_epubs(files, mode, out_filepath):
    print(f"\n[*] Processing {len(files)} EPUB eBook(s)...")
    plans = []

    for filepath in files:
        plan = []
        with zipfile.ZipFile(filepath, 'r') as zin:
            namelist = zin.namelist()
            t_files = [x for x in namelist if x.startswith('OEBPS/Text/chapter_trans_') and x.endswith('.html')]
            
            def get_epub_num(fname):
                m = re.search(r'_trans_(\d+)', fname)
                return int(m.group(1)) if m else 999999
                
            t_files.sort(key=get_epub_num)
            for t in t_files:
                num_str = re.search(r'_trans_(\d+)', t).group(1)
                r_file = f'OEBPS/Text/chapter_raw_{num_str}.html'
                if r_file not in namelist:
                    r_file = None
                plan.append((filepath, t, r_file))
        plans.append(plan)

    final_plan = combine_plans(plans, mode)
    if not final_plan: return

    book_title = "Merged ReadOmni Book"
    book_uuid = "urn:uuid:" + str(uuid.uuid4())

    # Extract base title from first file
    with zipfile.ZipFile(files[0], 'r') as zin:
        if 'OEBPS/content.opf' in zin.namelist():
            opf_content = zin.read('OEBPS/content.opf').decode('utf-8', 'ignore')
            title_match = re.search(r'<dc:title>(.*?)</dc:title>', opf_content)
            if title_match:
                book_title = title_match.group(1) + " (Merged)"

    print("  [+] Rebuilding merged EPUB Manifest and TOC...")
    open_zips = {f: zipfile.ZipFile(f, 'r') for f in set(files)}
    
    manifest_items = ""
    spine_items = ""
    navmap_items = ""
    play_order = 1

    with zipfile.ZipFile(out_filepath, 'w') as zout:
        zout.writestr('mimetype', b'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        container_xml = '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>'
        zout.writestr('META-INF/container.xml', container_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        for global_idx, (fp, t_file, r_file) in enumerate(final_plan, 1):
            zin = open_zips[fp]
            
            # Process Translated
            t_content = update_html_tags(zin.read(t_file).decode('utf-8', 'ignore'), global_idx)
            t_title = extract_h1_title(t_content)
            new_t_filename = f'chapter_trans_{global_idx:03d}.html'
            new_t_id = f'chapter_trans_{global_idx:03d}'
            
            zout.writestr(f'OEBPS/Text/{new_t_filename}', t_content.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
            manifest_items += f'<item id="{new_t_id}" href="Text/{new_t_filename}" media-type="application/xhtml+xml"/>\n'
            spine_items += f'<itemref idref="{new_t_id}"/>\n'
            navmap_items += f'<navPoint id="navPoint-{play_order}" playOrder="{play_order}"><navLabel><text>{t_title}</text></navLabel><content src="Text/{new_t_filename}"/></navPoint>\n'
            play_order += 1
            
            # Process Raw
            if r_file:
                r_content = update_html_tags(zin.read(r_file).decode('utf-8', 'ignore'), global_idx)
                r_title = extract_h1_title(r_content)
                new_r_filename = f'chapter_raw_{global_idx:03d}.html'
                new_r_id = f'chapter_raw_{global_idx:03d}'
                
                zout.writestr(f'OEBPS/Text/{new_r_filename}', r_content.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
                manifest_items += f'<item id="{new_r_id}" href="Text/{new_r_filename}" media-type="application/xhtml+xml"/>\n'
                spine_items += f'<itemref idref="{new_r_id}"/>\n'
                navmap_items += f'<navPoint id="navPoint-{play_order}" playOrder="{play_order}"><navLabel><text>{r_title}</text></navLabel><content src="Text/{new_r_filename}"/></navPoint>\n'
                play_order += 1

        opf_xml = f'<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n<dc:title>{book_title}</dc:title>\n<dc:language>en</dc:language>\n<dc:identifier id="BookId">{book_uuid}</dc:identifier>\n</metadata>\n<manifest>\n<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n{manifest_items}</manifest>\n<spine toc="ncx">\n{spine_items}</spine>\n</package>'
        zout.writestr('OEBPS/content.opf', opf_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        ncx_xml = f'<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head><meta name="dtb:uid" content="{book_uuid}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n<docTitle><text>{book_title}</text></docTitle>\n<navMap>\n{navmap_items}</navMap>\n</ncx>'
        zout.writestr('OEBPS/toc.ncx', ncx_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

    for z in open_zips.values(): z.close()
    print(f"  [+] Saved to: {out_filepath}")

def print_usage():
    print("Usage:")
    print("  1. Directory Merge:  python merge_readomni.py")
    print("  2. Append Explicit:  python merge_readomni.py <file1> <file2>")
    print("  3. Insert In-Betwen: python merge_readomni.py --in-between <file1> <file2>")

def main():
    print("--- ReadOmni Advanced Merger ---\n")
    args = sys.argv[1:]
    mode = 'directory'
    files_to_process = []
    
    # Parse CLI Arguments
    if len(args) == 0:
        mode = 'directory'
    elif len(args) == 2 and not args[0].startswith('--'):
        mode = 'append'
        files_to_process = [args[0], args[1]]
    elif len(args) == 3 and args[0] == '--in-between':
        mode = 'in-between'
        files_to_process = [args[1], args[2]]
    else:
        print_usage()
        return

    # Create Output Directory
    out_dir = os.path.join(os.getcwd(), 'merged')
    if not os.path.exists(out_dir):
        os.makedirs(out_dir)

    # Route logic based on mode
    if mode == 'directory':
        print("Note: All files will be joined in natural sequential order.\n")
        files = [f for f in os.listdir(os.getcwd()) if os.path.isfile(f)]
        html_files = sorted([f for f in files if f.endswith('.html')], key=natural_sort_key)
        zip_files = sorted([f for f in files if f.endswith('.zip')], key=natural_sort_key)
        epub_files = sorted([f for f in files if f.endswith('.epub')], key=natural_sort_key)
        
        if not (html_files or zip_files or epub_files):
            print("No valid ReadOmni files found in the current directory.")
            return

        if len(html_files) > 1:
            if input(f"Found {len(html_files)} HTML files. Merge them? (y/n): ").strip().lower() == 'y':
                handle_htmls(html_files, mode, os.path.join(out_dir, "Merged_App.html"))
        if len(zip_files) > 1:
            if input(f"Found {len(zip_files)} ZIP files. Merge them? (y/n): ").strip().lower() == 'y':
                handle_zips(zip_files, mode, os.path.join(out_dir, "Merged_Archive.zip"))
        if len(epub_files) > 1:
            if input(f"Found {len(epub_files)} EPUB files. Merge them? (y/n): ").strip().lower() == 'y':
                handle_epubs(epub_files, mode, os.path.join(out_dir, "Merged_eBook.epub"))
                
    else:
        # Append or In-Between explicit files
        for f in files_to_process:
            if not os.path.exists(f):
                print(f"Error: File not found -> {f}")
                return
                
        ext1 = os.path.splitext(files_to_process[0])[1].lower()
        ext2 = os.path.splitext(files_to_process[1])[1].lower()
        
        if ext1 != ext2:
            print(f"Error: Files must be of the exact same type ({ext1} vs {ext2}).")
            return
            
        base_name = os.path.splitext(os.path.basename(files_to_process[0]))[0]
        out_filepath = os.path.join(out_dir, f"{base_name}_Merged{ext1}")

        if ext1 == '.html':
            handle_htmls(files_to_process, mode, out_filepath)
        elif ext1 == '.zip':
            handle_zips(files_to_process, mode, out_filepath)
        elif ext1 == '.epub':
            handle_epubs(files_to_process, mode, out_filepath)
        else:
            print(f"Error: Unsupported file format {ext1}. Use .html, .zip, or .epub")

    print("\n--- Process Completed! Check the 'merged' folder. ---")

if __name__ == '__main__':
    main()