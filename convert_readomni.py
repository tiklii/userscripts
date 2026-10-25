#!/usr/bin/env python3
"""
ReadOmni ZIP to EPUB Converter
Version: 2.0.0

Description:
    Converts downloaded chapter ZIP archives from the ReadOmni userscript 
    (v41 and compatible) into cleanly structured EPUB eBooks. 
    
    Produces an EPUB identical in layout, styling, and navigation to the 
    native EPUB export of the Userscript:
      - Translated chapters only (no raw text)
      - External stylesheet (OEBPS/Styles/style.css) with dark-mode support
      - Clean single-level NCX Table of Contents
      - Strict XHTML compliance for e-reader compatibility
      - Interactive prompts for Book Title and Author metadata
"""

import os
import re
import sys
import uuid
import zipfile
import html

# --- UTILITIES ---

def escape_xml(unsafe_text):
    """Escapes standard XML special characters."""
    return (
        unsafe_text.replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;')
        .replace("'", '&apos;')
    )

def sanitize_filename(name):
    """Sanitizes strings for safe filesystem file naming."""
    return re.sub(r'[\/\\?%*:|"<>]', '_', name)

def natural_sort_key(s):
    """Sorts strings containing numbers in human order (e.g., [2] before [10])."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]

def clean_derived_title(zip_filename):
    """Strips extension, timestamps, and converts underscores to spaces."""
    base = os.path.splitext(os.path.basename(zip_filename))[0]
    # Remove trailing date/timestamp patterns like _2025-05-18_14-30 or _2025_05_18-14-30
    cleaned = re.sub(r'_\d{4}[-_]\d{2}[-_]\d{2}[-_].*$', '', base)
    cleaned = re.sub(r'_\d{4}[-_]\d{2}[-_]\d{2}$', '', cleaned)
    return cleaned.replace('_', ' ').strip() or "ReadOmni Book"

def get_title_from_html(raw_html):
    """Extracts chapter title from <h1> or <title>, stripping pre-existing [xx] indices."""
    match = re.search(r'<h1>(.*?)</h1>', raw_html, re.IGNORECASE)
    if not match:
        match = re.search(r'<title>(.*?)</title>', raw_html, re.IGNORECASE)

    raw_title = match.group(1).strip() if match else "Untitled Chapter"
    # Remove HTML tags if present inside the heading
    clean_title = re.sub(r'<[^>]+>', '', raw_title).strip()
    # Strip any existing leading [01], [1], etc., to prevent [01] [01] Chapter Name
    clean_title = re.sub(r'^\[\d+\]\s*', '', clean_title)
    return clean_title or "Untitled Chapter"

def get_inner_content(full_html):
    """Extracts inner body content below the primary <h1> tag."""
    match = re.search(r'<h1>.*?</h1>\s*(.*?)\s*</body>', full_html, re.DOTALL | re.IGNORECASE)
    content = match.group(1).strip() if match else full_html

    # Ensure self-closing tags are XML compliant
    content = re.sub(r'<br\s*\/?>', '<br/>', content, flags=re.IGNORECASE)
    content = re.sub(r'<hr\s*\/?>', '<hr/>', content, flags=re.IGNORECASE)
    content = re.sub(r'<img([^>]*?)(?<!/)>', r'<img\1/>', content, flags=re.IGNORECASE)

    # Convert common HTML named entities to numeric XML entities
    entity_map = {
        '&nbsp;': '&#160;',
        '&mdash;': '&#8212;',
        '&ndash;': '&#8211;',
        '&hellip;': '&#8230;',
        '&ldquo;': '&#8220;',
        '&rdquo;': '&#8221;',
        '&lsquo;': '&#8216;',
        '&rsquo;': '&#8217;',
    }
    for ent, num in entity_map.items():
        content = content.replace(ent, num)

    return content

# --- EXTRACTION ---

def extract_chapters_from_zip(zip_filepath):
    """Reads translated chapter files from the Translated/ folder of the archive."""
    chapters = []
    with zipfile.ZipFile(zip_filepath, 'r') as zin:
        namelist = zin.namelist()
        trans_files = sorted(
            [f for f in namelist if f.startswith('Translated/') and f.endswith('.html')],
            key=natural_sort_key
        )

        if not trans_files:
            raise ValueError("No chapter files found in the 'Translated/' directory of this archive.")

        for t_file in trans_files:
            raw_html = zin.read(t_file).decode('utf-8', errors='ignore')
            title = get_title_from_html(raw_html)
            content = get_inner_content(raw_html)

            chapters.append({
                "title": title,
                "content": content
            })

    return chapters

# --- EPUB BUILDER (IDENTICAL TO V41) ---

def generate_epub(book_title, author, chapters, out_filepath):
    """Constructs an EPUB matching Userscript v41 output specifications."""
    book_uuid = "urn:uuid:" + str(uuid.uuid4())

    css_content = (
        'body { font-family: sans-serif; line-height: 1.6; padding: 2% 5%; color: #111; background: #fff; } '
        'h1 { text-align: center; margin-bottom: 1.5em; font-size: 1.6em; padding-bottom: 0.5em; border-bottom: 1px solid #eaeaea; } '
        'p { margin-bottom: 1.2em; font-size: 1.1em; white-space: pre-line; } '
        'blockquote { border-left: 4px solid #ccc; padding-left: 1em; margin-left: 0; font-style: italic; color: #555; } '
        '.box { border: 1px solid #eaeaea; background-color: #f4f4f5; border-radius: 8px; padding: 16px; margin: 24px 0; } '
        '.box p:last-child { margin-bottom: 0; } '
        '@media (prefers-color-scheme: dark) { '
        'body { background: #121212; color: #eee; } '
        'h1 { border-color: #333; } '
        'blockquote { color: #9ca3af; border-color: #4b5563; } '
        '.box { border-color: #333; background: #1f1f1f; } '
        '}'
    )

    container_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n'
        '</container>'
    )

    with zipfile.ZipFile(out_filepath, 'w') as zout:
        # 1. mimetype (Uncompressed, first file in ZIP)
        zout.writestr('mimetype', b'application/epub+zip', compress_type=zipfile.ZIP_STORED)

        # 2. META-INF/container.xml
        zout.writestr('META-INF/container.xml', container_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        # 3. OEBPS/Styles/style.css
        zout.writestr('OEBPS/Styles/style.css', css_content.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        manifest_items = [
            '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
            '<item id="css" href="Styles/style.css" media-type="text/css"/>'
        ]
        spine_items = []
        navmap_items = []

        # 4. Chapters
        for i, chap in enumerate(chapters, 1):
            file_num = f"{i:03d}"
            chapter_id = f"chapter_{file_num}"
            chapter_filename = f"Text/{chapter_id}.html"

            # 2-digit index prefix in chapter heading (same as userscript v41)
            display_title = f"[{i:02d}] {chap['title']}"
            safe_title = escape_xml(display_title)
            safe_content = chap['content']

            chapter_html = (
                '<?xml version="1.0" encoding="utf-8"?>\n'
                '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n'
                '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">\n'
                f'<head><title>{safe_title}</title>\n'
                '<link rel="stylesheet" href="../Styles/style.css" type="text/css"/>\n'
                '</head>\n'
                f'<body>\n<h1>{safe_title}</h1>\n{safe_content}\n</body>\n'
                '</html>'
            )

            zout.writestr(f"OEBPS/{chapter_filename}", chapter_html.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

            manifest_items.append(f'<item id="{chapter_id}" href="{chapter_filename}" media-type="application/xhtml+xml"/>')
            spine_items.append(f'<itemref idref="{chapter_id}"/>')
            navmap_items.append(
                f'<navPoint id="navPoint-{i}" playOrder="{i}">'
                f'<navLabel><text>{safe_title}</text></navLabel>'
                f'<content src="{chapter_filename}"/>'
                f'</navPoint>'
            )

        # 5. OEBPS/content.opf
        manifest_str = "\n".join(manifest_items)
        spine_str = "\n".join(spine_items)
        safe_book_title = escape_xml(book_title)
        safe_author = escape_xml(author)

        opf_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">\n'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n'
            f'<dc:title>{safe_book_title}</dc:title>\n'
            f'<dc:creator opf:role="aut">{safe_author}</dc:creator>\n'
            '<dc:language>en</dc:language>\n'
            f'<dc:identifier id="BookId">{book_uuid}</dc:identifier>\n'
            '</metadata>\n'
            f'<manifest>\n{manifest_str}\n</manifest>\n'
            f'<spine toc="ncx">\n{spine_str}\n</spine>\n'
            '</package>'
        )
        zout.writestr('OEBPS/content.opf', opf_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

        # 6. OEBPS/toc.ncx
        navmap_str = "\n".join(navmap_items)
        ncx_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
            f'<head><meta name="dtb:uid" content="{book_uuid}"/><meta name="dtb:depth" content="1"/>'
            '<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n'
            f'<docTitle><text>{safe_book_title}</text></docTitle>\n'
            f'<navMap>\n{navmap_str}\n</navMap>\n'
            '</ncx>'
        )
        zout.writestr('OEBPS/toc.ncx', ncx_xml.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)

# --- MAIN ---

def main():
    print("==========================================")
    print(" ReadOmni ZIP to EPUB Converter (v2.0.0)  ")
    print("==========================================\n")

    if len(sys.argv) > 1:
        zip_path = sys.argv[1].strip()
    else:
        zip_path = input("Enter path to ReadOmni ZIP file: ").strip().strip('\'"')

    if not zip_path:
        print("Error: No file specified.")
        return

    if not os.path.exists(zip_path):
        print(f"Error: File '{zip_path}' not found.")
        return

    if not zip_path.lower().endswith('.zip'):
        print("Error: Input file must be a .zip archive.")
        return

    try:
        print("\n  -> Parsing ZIP archive...")
        chapters = extract_chapters_from_zip(zip_path)
    except Exception as e:
        print(f"Extraction failed: {e}")
        return

    print(f"  [*] Successfully extracted {len(chapters)} translated chapters.")

    # Derive default title
    suggested_title = clean_derived_title(zip_path)
    suggested_author = "Unknown"

    print("\n--- Book Metadata Setup ---")
    title_input = input(f"Enter Book Title [{suggested_title}]: ").strip()
    book_title = title_input if title_input else suggested_title

    author_input = input(f"Enter Author [{suggested_author}]: ").strip()
    author = author_input if author_input else suggested_author

    # Output directory & file naming
    out_dir = os.path.join(os.getcwd(), 'converted')
    os.makedirs(out_dir, exist_ok=True)

    safe_base = sanitize_filename(book_title.replace(' ', '_'))
    out_epub_path = os.path.join(out_dir, f"{safe_base}.epub")

    print(f"\n  [+] Generating EPUB: {os.path.basename(out_epub_path)}")
    try:
        generate_epub(book_title, author, chapters, out_epub_path)
        print(f"\n[✓] Completed! Saved to: {out_epub_path}")
    except Exception as e:
        print(f"EPUB generation failed: {e}")

if __name__ == '__main__':
    main()