import zipfile
import re
import argparse
import sys
import posixpath
from bs4 import BeautifulSoup

# Colors for terminal output
C_GREEN = '\033[92m'
C_YELLOW = '\033[93m'
C_RED = '\033[91m'
C_BLUE = '\033[94m'
C_RESET = '\033[0m'

# Regex to match "Chapter xxx", "Ch xxx", "Ch. xxx", case insensitive.
# Captures the integer number.
CHAPTER_PATTERN = re.compile(r"(?:chapter|ch\.?|chp\.?)\s*(\d+)", re.IGNORECASE)

def get_opf_path(z):
    """Finds the OPF (packaging) file path inside the EPUB."""
    try:
        container = z.read("META-INF/container.xml")
        soup = BeautifulSoup(container, "xml")
        rootfile = soup.find("rootfile")
        if rootfile and rootfile.get("full-path"):
            return rootfile.get("full-path")
    except Exception as e:
        print(f"{C_RED}Error reading META-INF/container.xml: {e}{C_RESET}")
    return None

def extract_toc_chapters(z, opf_soup, opf_dir):
    """Yields chapter numbers and titles by parsing the EPUB's TOC."""
    titles = []

    # 1. Try EPUB2 NCX method
    spine = opf_soup.find("spine")
    toc_id = spine.get("toc") if spine else None
    if toc_id:
        toc_item = opf_soup.find("item", id=toc_id)
        if toc_item and toc_item.get("href"):
            toc_path = posixpath.normpath(posixpath.join(opf_dir, toc_item.get("href")))
            try:
                ncx_soup = BeautifulSoup(z.read(toc_path), "xml")
                # NCX uses <navLabel><text>...</text></navLabel>
                for text_tag in ncx_soup.find_all("text"):
                    if text_tag.parent and text_tag.parent.name.lower() == "navlabel":
                        titles.append(text_tag.get_text(strip=True))
            except Exception:
                pass

    # 2. Try EPUB3 Navigation Document method (if NCX failed or is empty)
    if not titles:
        nav_item = opf_soup.find("item", properties=lambda x: x and "nav" in x)
        if nav_item and nav_item.get("href"):
            nav_path = posixpath.normpath(posixpath.join(opf_dir, nav_item.get("href")))
            try:
                nav_soup = BeautifulSoup(z.read(nav_path), "html.parser")
                nav_tag = nav_soup.find("nav")
                if nav_tag:
                    for a_tag in nav_tag.find_all("a"):
                        titles.append(a_tag.get_text(strip=True))
            except Exception:
                pass

    # Process and yield matching titles
    for title in titles:
        match = CHAPTER_PATTERN.search(title)
        if match:
            yield title, int(match.group(1))

def stream_first_para_chapters(z, opf_soup, opf_dir):
    """Yields chapter numbers and text by scanning the first paragraphs of HTML files."""
    spine = opf_soup.find("spine")
    manifest = opf_soup.find("manifest")

    if not spine or not manifest:
        return

    # Create a mapping of item IDs to their file paths
    item_dict = {item.get("id"): item.get("href") for item in manifest.find_all("item") if item.get("href")}

    # Iterate through reading order
    for itemref in spine.find_all("itemref"):
        idref = itemref.get("idref")
        href = item_dict.get(idref)
        if not href:
            continue

        file_path = posixpath.normpath(posixpath.join(opf_dir, href))
        try:
            content = z.read(file_path)
            soup = BeautifulSoup(content, "html.parser")

            # Extract first few relevant tags (headings and paragraphs)
            tags = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'], limit=15)
            for tag in tags:
                text = tag.get_text(strip=True)
                match = CHAPTER_PATTERN.search(text)
                if match:
                    yield text, int(match.group(1))
                    break  # Stop at the FIRST occurrence in this file
        except Exception:
            pass

def analyze_chapters(chapter_stream):
    """Consumes the chapter stream, reports progress, missing, out-of-order, and duplicate chapters."""
    last_seen = None

    missing_chapters = []
    out_of_order_chapters = []
    duplicate_chapters = []

    print(f"\n{C_BLUE}--- Starting Chapter Analysis ---{C_RESET}\n")

    for raw_text, current_num in chapter_stream:
        # Format the display text to not flood the terminal if it's a long paragraph
        display_text = raw_text if len(raw_text) < 60 else raw_text[:57] + "..."
        print(f"Found: {C_GREEN}Chapter {current_num}{C_RESET}  ({display_text})")
        sys.stdout.flush()

        if last_seen is None:
            last_seen = current_num
            continue

        if current_num == last_seen:
            print(f"  {C_YELLOW}[~] Duplicate or Split Chapter detected: {current_num}{C_RESET}")
            duplicate_chapters.append(current_num)
        elif current_num == last_seen + 1:
            last_seen = current_num
        elif current_num > last_seen + 1:
            # Report missing chapters
            for m in range(last_seen + 1, current_num):
                print(f"  {C_RED}[!] MISSING: Chapter {m}{C_RESET}")
                missing_chapters.append(m)
            last_seen = current_num
        elif current_num < last_seen:
            # Report out of order
            print(f"  {C_RED}[!] OUT OF ORDER: Chapter {current_num} (Last seen was {last_seen}){C_RESET}")
            out_of_order_chapters.append(current_num)

    # Print final summary stats
    print(f"\n{C_BLUE}--- Analysis Complete ---{C_RESET}")
    print(f"Missing Chapters    : {C_RED}{len(missing_chapters)}{C_RESET}")
    print(f"Out of Order Items  : {C_RED}{len(out_of_order_chapters)}{C_RESET}")
    print(f"Duplicates/Splits   : {C_YELLOW}{len(duplicate_chapters)}{C_RESET}")

    # Print detailed lists if any issues were found
    if missing_chapters or out_of_order_chapters or duplicate_chapters:
        print(f"\n{C_BLUE}--- Detailed Lists ---{C_RESET}")

        if missing_chapters:
            # Format the missing array to highlight items that were actually found out of order
            missing_strs = []
            has_ooo_in_missing = False
            for m in missing_chapters:
                if m in out_of_order_chapters:
                    missing_strs.append(f"{C_GREEN}{m}*{C_RED}")
                    has_ooo_in_missing = True
                else:
                    missing_strs.append(str(m))

            missing_text = ', '.join(missing_strs)
            legend = f" {C_RESET}({C_GREEN}*Green{C_RESET} = Found later out-of-order)" if has_ooo_in_missing else ""
            print(f"Missing       : {C_RED}{missing_text}{C_RESET}{legend}")

        if out_of_order_chapters:
            print(f"Out of Order  : {C_RED}{', '.join(map(str, out_of_order_chapters))}{C_RESET}")
        if duplicate_chapters:
            print(f"Duplicates    : {C_YELLOW}{', '.join(map(str, duplicate_chapters))}{C_RESET}")
    else:
        print(f"\n{C_GREEN}Everything looks perfectly in order!{C_RESET}")

def main():
    parser = argparse.ArgumentParser(description="Find missing and out-of-order chapters in an EPUB.")
    parser.add_argument("epub_path", help="Path to the EPUB file")
    parser.add_argument("--first-para", action="store_true",
                        help="Scan the first few paragraphs/headings of files instead of the TOC")
    args = parser.parse_args()

    try:
        with zipfile.ZipFile(args.epub_path, 'r') as z:
            opf_path = get_opf_path(z)
            if not opf_path:
                print(f"{C_RED}Could not locate OPF file. Is this a valid EPUB?{C_RESET}")
                sys.exit(1)

            opf_dir = posixpath.dirname(opf_path)
            opf_content = z.read(opf_path)

            # Using xml parser for OPF processing
            opf_soup = BeautifulSoup(opf_content, "xml")

            if args.first_para:
                print(f"Mode: {C_YELLOW}First Paragraph / Heading Scan{C_RESET}")
                chapter_stream = stream_first_para_chapters(z, opf_soup, opf_dir)
            else:
                print(f"Mode: {C_YELLOW}Table of Contents (TOC) Scan{C_RESET}")
                chapter_stream = extract_toc_chapters(z, opf_soup, opf_dir)

            analyze_chapters(chapter_stream)

    except zipfile.BadZipFile:
        print(f"{C_RED}Error: The file provided is not a valid ZIP/EPUB archive.{C_RESET}")
    except FileNotFoundError:
        print(f"{C_RED}Error: File not found at '{args.epub_path}'{C_RESET}")

if __name__ == "__main__":
    main()
