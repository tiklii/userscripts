#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
ReadOmni File Merger (EPUB & ZIP)
Version: 3.0.0
Author: tiklii & contributors

Seamlessly combines and re-indexes ReadOmni downloads (.epub eBooks and .zip archives).
Supports both legacy dual-stream (trans/raw) and modern single-stream chapter structures.
"""

import os
import re
import sys
import uuid
import zipfile

VERSION = "3.0.0"

# ANSI Terminal Colors
C_GREEN = '\033[92m'
C_YELLOW = '\033[93m'
C_RED = '\033[91m'
C_BLUE = '\033[94m'
C_RESET = '\033[0m'


def natural_sort_key(s):
    """Splits strings into text and numbers for natural sorting (e.g. Chapter 2 before Chapter 10)."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', str(s))]


def extract_h1_title(html_content):
    """Extracts clean title text from <h1> or <title> tags for TOC generation."""
    m_h1 = re.search(r'<h1[^>]*>(.*?)</h1>', html_content, re.IGNORECASE | re.DOTALL)
    if m_h1:
        clean = re.sub(r'<[^>]+>', '', m_h1.group(1))
        return clean.strip()

    m_title = re.search(r'<title[^>]*>(.*?)</title>', html_content, re.IGNORECASE | re.DOTALL)
    if m_title:
        clean = re.sub(r'<[^>]+>', '', m_title.group(1))
        return clean.strip()

    return "Untitled Chapter"


def update_html_tags(html_content, new_num):
    """
    Normalizes chapter tags, updates the sequential [XX] prefix, and updates
    any internal cross-links between translated and raw views.
    """
    # Normalize legacy raw naming suffixes
    html_content = html_content.replace(' - Raw</title>', ' (Raw)</title>')
    html_content = html_content.replace(' - Raw</h1>', ' (Raw)</h1>')

    # Update relative chapter cross-links (supporting both modern and legacy targets)
    html_content = re.sub(
        r'(href="(?:Text/)?chapter_(raw|trans)_)(\d+)(\.html")',
        lambda m: f"{m.group(1)}{new_num:03d}{m.group(4)}",
        html_content
    )
    html_content = re.sub(
        r'(href="(?:Text/)?chapter_)(\d+)(\.html")',
        lambda m: f"{m.group(1)}{new_num:03d}{m.group(3)}",
        html_content
    )

    # Update <title> tag
    def title_replace(match):
        inner = re.sub(r'<[^>]+>', '', match.group(1)).strip()
        inner = re.sub(r'^\[\d+\]\s*', '', inner)
        return f"<title>[{new_num:02d}] {inner}</title>"

    html_content = re.sub(r'<title[^>]*>(.*?)</title>', title_replace, html_content, count=1, flags=re.IGNORECASE | re.DOTALL)

    # Update <h1> tag
    def h1_replace(match):
        inner = match.group(1).strip()
        inner = inner.replace(' - Raw', ' (Raw)')
        if re.search(r'\[\d+\]', inner):
            inner = re.sub(r'\[\d+\]\s*', f'[{new_num:02d}] ', inner, count=1)
        else:
            inner = f"[{new_num:02d}] {inner}"
        return f"<h1>{inner}</h1>"

    html_content = re.sub(r'<h1[^>]*>(.*?)</h1>', h1_replace, html_content, count=1, flags=re.IGNORECASE | re.DOTALL)
    return html_content


def escape_xml(unsafe):
    """Escapes special characters for XML/NCX/OPF documents."""
    return (unsafe.replace("&", "&amp;")
                  .replace("<", "&lt;")
                  .replace(">", "&gt;")
                  .replace('"', "&quot;")
                  .replace("'", "&apos;"))


def combine_plans(plans, mode):
    """Combines extracted chapter plans based on the active mode."""
    if mode in ('directory', 'append'):
        combined = []
        for p in plans:
            combined.extend(p)
        return combined

    elif mode == 'in-between':
        p1, p2 = plans[0], plans[1]
        max_idx = len(p1)
        print(f"\n{C_BLUE}[?] Base File A contains {max_idx} chapters. File B contains {len(p2)} chapters.{C_RESET}")
        while True:
            try:
                ans = input(f"    Insert File B AFTER which chapter number of File A? (0 = prepend at start, {max_idx} = append at end): ")
                idx = int(ans)
                if 0 <= idx <= max_idx:
                    return p1[:idx] + p2 + p1[idx:]
                print(f"    {C_RED}[!] Index out of range (0 to {max_idx}). Please try again.{C_RESET}")
            except ValueError:
                print(f"    {C_RED}[!] Please enter a valid integer.{C_RESET}")

    return []


# ==============================================================================
# ZIP ARCHIVE HANDLING
# ==============================================================================

def handle_zips(files, mode, out_filepath):
    print(f"\n{C_BLUE}[*] Processing {len(files)} ZIP Archive(s)...{C_RESET}")
    open_zips = {f: zipfile.ZipFile(f, 'r') for f in set(files)}
    plans = []

    for filepath in files:
        plan = []
        zin = open_zips[filepath]
        namelist = zin.namelist()

        # Identify translated files
        t_files = [x for x in namelist if x.startswith('Translated/') and x.endswith('.html')]

        def get_zip_num(fname):
            m = re.search(r'\[(\d+)\]', os.path.basename(fname))
            if m:
                return int(m.group(1))
            m2 = re.search(r'(\d+)', os.path.basename(fname))
            return int(m2.group(1)) if m2 else 999999

        t_files.sort(key=lambda x: (get_zip_num(x), natural_sort_key(x)))

        # Map available raw chapters by their detected index
        r_files = [x for x in namelist if x.startswith('Raw/') and x.endswith('.html')]
        r_dict = {get_zip_num(x): x for x in r_files}

        for t in t_files:
            num = get_zip_num(t)
            r = r_dict.get(num)
            plan.append({
                'fp': filepath,
                't_file': t,
                'r_file': r,
                'get_content': lambda f=filepath, tf=t: open_zips[f].read(tf).decode('utf-8', 'ignore')
            })
        plans.append(plan)

    final_plan = combine_plans(plans, mode)
    if not final_plan:
        print(f"  {C_RED}[!] No chapters found or operation cancelled.{C_RESET}")
        for z in open_zips.values():
            z.close()
        return

    print(f"\n  {C_GREEN}[+] Assembling merged ZIP ({len(final_plan)} total chapters)...{C_RESET}")
    copied_assets = set()

    with zipfile.ZipFile(out_filepath, 'w', zipfile.ZIP_DEFLATED) as zout:
        # 1. Copy over non-chapter assets (images, styles, etc.)
        for filepath in files:
            zin = open_zips[filepath]
            for item in zin.namelist():
                if item in copied_assets:
                    continue
                # Skip chapters (handled specifically below)
                if (item.startswith('Translated/') and item.endswith('.html')) or \
                   (item.startswith('Raw/') and item.endswith('.html')):
                    continue
                zout.writestr(zin.getinfo(item), zin.read(item))
                copied_assets.add(item)

        # 2. Write merged chapters with normalized indexing
        for global_idx, item in enumerate(final_plan, 1):
            zin = open_zips[item['fp']]

            # Translated chapter
            t_content = update_html_tags(zin.read(item['t_file']).decode('utf-8', 'ignore'), global_idx)
            orig_t_name = os.path.basename(item['t_file'])
            if re.search(r'\[\d+\]', orig_t_name):
                new_t_name = re.sub(r'\[\d+\]\s*', f'[{global_idx:02d}] ', orig_t_name, count=1)
            else:
                new_t_name = f'[{global_idx:02d}] {orig_t_name}'
            zout.writestr(f"Translated/{new_t_name}", t_content.encode('utf-8'))

            # Raw chapter (if available)
            if item['r_file']:
                r_content = update_html_tags(zin.read(item['r_file']).decode('utf-8', 'ignore'), global_idx)
                orig_r_name = os.path.basename(item['r_file']).replace(' - Raw.html', ' (Raw).html')
                if re.search(r'\[\d+\]', orig_r_name):
                    new_r_name = re.sub(r'\[\d+\]\s*', f'[{global_idx:02d}] ', orig_r_name, count=1)
                else:
                    new_r_name = f'[{global_idx:02d}] {orig_r_name}'
                zout.writestr(f"Raw/{new_r_name}", r_content.encode('utf-8'))

    for z in open_zips.values():
        z.close()
    print(f"  {C_GREEN}[+] Successfully saved to: {out_filepath}{C_RESET}")


# ==============================================================================
# EPUB EBOOK HANDLING (CROSS-VERSION SUPPORT)
# ==============================================================================

def handle_epubs(files, mode, out_filepath):
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

        # Locate content.opf
        opf_path = next((f for f in namelist if f.lower().endswith('.opf')), 'OEBPS/content.opf')
        opf_content = ""
        spine_hrefs = []

        if opf_path in namelist:
            try:
                opf_content = zin.read(opf_path).decode('utf-8', 'ignore')
            except Exception:
                opf_content = ""

        # Parse reading order from OPF spine when available
        if opf_content:
            if idx == 0:
                m_match = re.search(r'<[a-zA-Z0-9:]*metadata[^>]*>.*?</[a-zA-Z0-9:]*metadata>', opf_content, re.DOTALL | re.IGNORECASE)
                if m_match:
                    base_metadata = m_match.group(0)

                s_match = re.search(r'<[a-zA-Z0-9:]*spine([^>]*)>(.*?)</[a-zA-Z0-9:]*spine>', opf_content, re.DOTALL | re.IGNORECASE)
                if s_match:
                    for item in re.findall(r'<[a-zA-Z0-9:]*itemref [^>]+/>', s_match.group(2), re.IGNORECASE):
                        if not re.search(r'idref="chapter_', item, re.IGNORECASE):
                            preserved_spine.append(item)

            # Preserve non-chapter assets in manifest
            man_match = re.search(r'<[a-zA-Z0-9:]*manifest>(.*?)</[a-zA-Z0-9:]*manifest>', opf_content, re.DOTALL | re.IGNORECASE)
            if man_match:
                manifest_items = re.findall(r'<[a-zA-Z0-9:]*item [^>]+/>', man_match.group(1), re.IGNORECASE)
                manifest_map = {}
                for item in manifest_items:
                    id_m = re.search(r'id="([^"]+)"', item, re.IGNORECASE)
                    href_m = re.search(r'href="([^"]+)"', item, re.IGNORECASE)
                    if id_m and href_m:
                        manifest_map[id_m.group(1)] = href_m.group(1)
                    if not re.search(r'id="chapter_', item, re.IGNORECASE) and 'toc.ncx' not in item:
                        preserved_manifest.add(item)

                # Collect spine ordering
                spine_match = re.search(r'<[a-zA-Z0-9:]*spine[^>]*>(.*?)</[a-zA-Z0-9:]*spine>', opf_content, re.DOTALL | re.IGNORECASE)
                if spine_match:
                    for ref in re.findall(r'idref="([^"]+)"', spine_match.group(1)):
                        if ref in manifest_map:
                            href = manifest_map[ref]
                            opf_dir = os.path.dirname(opf_path)
                            full_href = f"{opf_dir}/{href}".replace('\\', '/').lstrip('/') if opf_dir else href
                            spine_hrefs.append(full_href)

        # Identify chapter files (supports modern chapter_### and legacy chapter_trans_###)
        t_files = []
        if spine_hrefs:
            for h in spine_hrefs:
                if h in namelist and re.search(r'chapter_(trans_)?\d+\.html$', h, re.IGNORECASE):
                    t_files.append(h)

        if not t_files:
            for x in namelist:
                if (re.search(r'chapter_\d+\.html$', x, re.IGNORECASE) or
                    re.search(r'chapter_trans_\d+\.html$', x, re.IGNORECASE)) and not re.search(r'chapter_raw_\d+\.html$', x, re.IGNORECASE):
                    t_files.append(x)

            def get_epub_num(fname):
                m = re.search(r'chapter_(?:trans_)?(\d+)', fname, re.IGNORECASE)
                return int(m.group(1)) if m else 999999

            t_files.sort(key=lambda x: (get_epub_num(x), natural_sort_key(x)))

        for t in t_files:
            # Check for corresponding raw counterpart (legacy dual-mode EPUBs)
            r_file = None
            raw_match = re.search(r'(.*?chapter_)(?:trans_)?(\d+\.html)$', t, re.IGNORECASE)
            if raw_match:
                candidate_raw = f"{raw_match.group(1)}raw_{raw_match.group(2)}"
                if candidate_raw in namelist:
                    r_file = candidate_raw

            plan.append({
                'fp': filepath,
                't_file': t,
                'r_file': r_file,
                'get_content': lambda f=filepath, tf=t: open_zips[f].read(tf).decode('utf-8', 'ignore')
            })

        plans.append(plan)

    final_plan = combine_plans(plans, mode)
    if not final_plan:
        print(f"  {C_RED}[!] No chapters found or operation cancelled.{C_RESET}")
        for z in open_zips.values():
            z.close()
        return

    # Check if any chapters contain raw content
    has_any_raw = any(item['r_file'] is not None for item in final_plan)

    book_uuid = "urn:uuid:" + str(uuid.uuid4())
    if '<dc:identifier' in base_metadata:
        base_metadata = re.sub(r'<dc:identifier id="BookId">.*?</dc:identifier>', f'<dc:identifier id="BookId">{book_uuid}</dc:identifier>', base_metadata)
    else:
        base_metadata += f'\n<dc:identifier id="BookId">{book_uuid}</dc:identifier>'

    title_match = re.search(r'<dc:title>(.*?)</dc:title>', base_metadata, re.DOTALL | re.IGNORECASE)
    book_title = title_match.group(1).strip() + " (Merged)" if title_match else "Merged ReadOmni Book"

    print(f"\n  {C_GREEN}[+] Assembling merged EPUB ({len(final_plan)} chapters, Raw Stream: {'Yes' if has_any_raw else 'No'})...{C_RESET}")

    manifest_items = ""
    spine_items = ""
    navmap_items = ""
    play_order = 1

    with zipfile.ZipFile(out_filepath, 'w') as zout:
        # Standard uncompressed EPUB mimetype
        zout.writestr('mimetype', b'application/epub+zip', compress_type=zipfile.ZIP_STORED)

        container_xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                         '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
                         '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n'
                         '</container>')
        zout.writestr('META-INF/container.xml', container_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        # Copy over covers, fonts, styles, and other non-chapter assets
        for filepath in files:
            zin = open_zips[filepath]
            for item in zin.namelist():
                if item in copied_assets:
                    continue
                if (re.search(r'chapter_(?:raw_|trans_)?\d+\.html$', item, re.IGNORECASE) or
                    item.lower().endswith('.opf') or item.lower().endswith('.ncx') or
                    item == 'mimetype' or item == 'META-INF/container.xml'):
                    continue
                zout.writestr(zin.getinfo(item), zin.read(item))
                copied_assets.add(item)

        written_translated = []
        written_raw = []

        for global_idx, item in enumerate(final_plan, 1):
            zin = open_zips[item['fp']]

            # 1. Process Translated Chapter
            t_content = update_html_tags(zin.read(item['t_file']).decode('utf-8', 'ignore'), global_idx)
            t_title = extract_h1_title(t_content)

            if has_any_raw:
                t_filename = f'chapter_trans_{global_idx:03d}.html'
                t_id = f'chapter_trans_{global_idx:03d}'
            else:
                t_filename = f'chapter_{global_idx:03d}.html'
                t_id = f'chapter_{global_idx:03d}'

            zout.writestr(f'OEBPS/Text/{t_filename}', t_content.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
            manifest_items += f'  <item id="{t_id}" href="Text/{t_filename}" media-type="application/xhtml+xml"/>\n'
            spine_items += f'  <itemref idref="{t_id}"/>\n'
            written_translated.append((t_filename, t_title))

            # 2. Process Raw Chapter (if present)
            if item['r_file']:
                r_content = update_html_tags(zin.read(item['r_file']).decode('utf-8', 'ignore'), global_idx)
                r_title = extract_h1_title(r_content)
                r_filename = f'chapter_raw_{global_idx:03d}.html'
                r_id = f'chapter_raw_{global_idx:03d}'

                zout.writestr(f'OEBPS/Text/{r_filename}', r_content.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
                manifest_items += f'  <item id="{r_id}" href="Text/{r_filename}" media-type="application/xhtml+xml"/>\n'
                spine_items += f'  <itemref idref="{r_id}"/>\n'
                written_raw.append((r_filename, r_title))

        # Generate Table of Contents (NCX)
        if has_any_raw:
            # Dual stream: grouped into Translated and Raw sections
            if written_translated:
                first_t_file = written_translated[0][0]
                navmap_items += f'<navPoint id="navGroup-tl" playOrder="{play_order}">\n  <navLabel><text>Translated</text></navLabel>\n  <content src="Text/{first_t_file}"/>\n'
                play_order += 1
                for fn, title in written_translated:
                    navmap_items += f'  <navPoint id="navPoint-{play_order}" playOrder="{play_order}"><navLabel><text>{escape_xml(title)}</text></navLabel><content src="Text/{fn}"/></navPoint>\n'
                    play_order += 1
                navmap_items += '</navPoint>\n'

            if written_raw:
                first_r_file = written_raw[0][0]
                navmap_items += f'<navPoint id="navGroup-raw" playOrder="{play_order}">\n  <navLabel><text>Raw</text></navLabel>\n  <content src="Text/{first_r_file}"/>\n'
                play_order += 1
                for fn, title in written_raw:
                    navmap_items += f'  <navPoint id="navPoint-{play_order}" playOrder="{play_order}"><navLabel><text>{escape_xml(title)}</text></navLabel><content src="Text/{fn}"/></navPoint>\n'
                    play_order += 1
                navmap_items += '</navPoint>\n'
        else:
            # Single stream: clean flat chapter list (matches userscript v40 standard)
            for fn, title in written_translated:
                navmap_items += f'<navPoint id="navPoint-{play_order}" playOrder="{play_order}"><navLabel><text>{escape_xml(title)}</text></navLabel><content src="Text/{fn}"/></navPoint>\n'
                play_order += 1

        # Build content.opf
        preserved_man_str = "\n".join(f"  {x}" for x in preserved_manifest)
        preserved_spine_str = "\n".join(f"  {x}" for x in preserved_spine)

        opf_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
{base_metadata}
<manifest>
  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
{preserved_man_str}
{manifest_items}</manifest>
<spine toc="ncx">
{preserved_spine_str}
{spine_items}</spine>
</package>'''
        zout.writestr('OEBPS/content.opf', opf_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        # Build toc.ncx
        ncx_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
  <meta name="dtb:uid" content="{book_uuid}"/>
  <meta name="dtb:depth" content="2"/>
  <meta name="dtb:totalPageCount" content="0"/>
  <meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>{escape_xml(book_title)}</text></docTitle>
<navMap>
{navmap_items}</navMap>
</ncx>'''
        zout.writestr('OEBPS/toc.ncx', ncx_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

    for z in open_zips.values():
        z.close()
    print(f"  {C_GREEN}[+] Successfully saved to: {out_filepath}{C_RESET}")


# ==============================================================================
# CLI INTERFACE & DISPATCHER
# ==============================================================================

def print_help():
    print(f"""
{C_BLUE}======================================================
     ReadOmni File Merger - Version {VERSION}
======================================================{C_RESET}

Description:
  Merges ReadOmni downloads (.zip archives and .epub eBooks).
  Recalculates sequential [XX] numbering, rebuilds table of contents,
  and safely preserves covers, fonts, and styles.
  Backwards-compatible with downloads from both legacy and modern userscripts.

{C_YELLOW}Usage Modes:{C_RESET}

  {C_GREEN}1. Directory Mode (--dir){C_RESET}
     Scans the current working directory, groups files by extension (.zip / .epub),
     sorts them naturally, and merges them sequentially.

     Command:
       python merge_readomni.py --dir

  {C_GREEN}2. Append Mode (Default){C_RESET}
     Appends File B directly to the end of File A.

     Command:
       python merge_readomni.py <fileA> <fileB>
     Example:
       python merge_readomni.py "Book_Part1.epub" "Book_Part2.epub"

  {C_GREEN}3. In-Between Mode (--in-between){C_RESET}
     Interactively inserts File B inside File A at a designated chapter position.

     Command:
       python merge_readomni.py --in-between <fileA> <fileB>

Outputs:
  Merged files are saved directly into the 'merged/' subfolder.
  Original files are never modified.
""")


def main():
    args = sys.argv[1:]

    if not args or '-h' in args or '--help' in args:
        print_help()
        sys.exit(0)

    print(f"{C_BLUE}--- ReadOmni Merger v{VERSION} ---{C_RESET}\n")

    mode = None
    files_to_process = []

    if args[0] == '--dir':
        mode = 'directory'
    elif args[0] == '--in-between' and len(args) == 3:
        mode = 'in-between'
        files_to_process = [args[1], args[2]]
    elif len(args) == 2 and not args[0].startswith('--'):
        mode = 'append'
        files_to_process = [args[0], args[1]]
    else:
        print(f"{C_RED}[!] Invalid arguments provided. Run 'python merge_readomni.py --help' for instructions.{C_RESET}")
        sys.exit(1)

    out_dir = os.path.join(os.getcwd(), 'merged')
    os.makedirs(out_dir, exist_ok=True)

    if mode == 'directory':
        files = [f for f in os.listdir(os.getcwd()) if os.path.isfile(f)]
        zip_files = sorted([f for f in files if f.lower().endswith('.zip')], key=natural_sort_key)
        epub_files = sorted([f for f in files if f.lower().endswith('.epub')], key=natural_sort_key)

        if not (zip_files or epub_files):
            print(f"{C_YELLOW}No .zip or .epub files found in the current directory.{C_RESET}")
            sys.exit(0)

        if len(zip_files) > 1:
            ans = input(f"Found {len(zip_files)} ZIP archives. Merge them? (y/n): ").strip().lower()
            if ans == 'y':
                handle_zips(zip_files, mode, os.path.join(out_dir, "Merged_Archive.zip"))

        if len(epub_files) > 1:
            ans = input(f"Found {len(epub_files)} EPUB eBooks. Merge them? (y/n): ").strip().lower()
            if ans == 'y':
                handle_epubs(epub_files, mode, os.path.join(out_dir, "Merged_eBook.epub"))

    else:
        for f in files_to_process:
            if not os.path.exists(f):
                print(f"{C_RED}[!] Error: File not found: {f}{C_RESET}")
                sys.exit(1)

        ext1 = os.path.splitext(files_to_process[0])[1].lower()
        ext2 = os.path.splitext(files_to_process[1])[1].lower()

        if ext1 != ext2:
            print(f"{C_RED}[!] Error: File extensions must match ({ext1} vs {ext2}).{C_RESET}")
            sys.exit(1)

        base_name = os.path.splitext(os.path.basename(files_to_process[0]))[0]
        out_filepath = os.path.join(out_dir, f"{base_name}_Merged{ext1}")

        if ext1 == '.zip':
            handle_zips(files_to_process, mode, out_filepath)
        elif ext1 == '.epub':
            handle_epubs(files_to_process, mode, out_filepath)
        else:
            print(f"{C_RED}[!] Error: Unsupported file format {ext1}. Please use .zip or .epub.{C_RESET}")

    print(f"\n{C_BLUE}--- Process Completed! Files saved in 'merged/' folder. ---{C_RESET}")


if __name__ == '__main__':
    main()
