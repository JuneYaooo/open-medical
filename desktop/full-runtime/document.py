"""Bounded document I/O inside the Agent container. No network or host writes."""
import json
import base64
from pathlib import Path
import subprocess
import sys
import zipfile
import csv
import stat


def safe_path(value):
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("Only relative workspace paths are supported")
    target = (Path.cwd() / path).resolve()
    if not target.is_relative_to(Path.cwd()):
        raise ValueError("Path leaves workspace")
    return target


def inspect_zip(path):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(e.file_size for e in entries) > 100_000_000:
            raise ValueError("Expanded document exceeds 100MB / 2000 entries")


def archive_operation(request):
    path = safe_path(request["path"])
    action = request["action"]
    if action == "archive_create":
        files = request["paths"]
        if not files or len(files) > 100:
            raise ValueError("Select 1 to 100 files")
        sources = [(name, safe_path(name)) for name in files]
        if any(not source.is_file() or source == path for _, source in sources):
            raise ValueError("Sources must be files distinct from the output")
        if sum(source.stat().st_size for _, source in sources) > 100_000_000:
            raise ValueError("Source files exceed 100MB")
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            for _, source in sources:
                archive.write(source, source.relative_to(Path.cwd()).as_posix())
        return {"created": True, "files": len(sources), "bytes": path.stat().st_size}
    inspect_zip(path)
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        for entry in entries:
            name = entry.filename
            parts = Path(name).parts
            mode = entry.external_attr >> 16
            if (not name or "\\" in name or "\x00" in name or ":" in name or
                    Path(name).is_absolute() or ".." in parts or stat.S_ISLNK(mode) or
                    (stat.S_IFMT(mode) and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode))) or
                    entry.flag_bits & 1):
                raise ValueError("Archive has an unsafe path, special file, or encrypted entry")
        names = [entry.filename.rstrip("/") for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError("Archive has duplicate paths")
        manifest = [{"path": entry.filename, "bytes": entry.file_size, "directory": entry.is_dir()} for entry in entries]
        if action == "archive_extract":
            target = safe_path(request["destination"])
            if target == Path.cwd() or target.exists():
                raise ValueError("Destination must be a new directory")
            # Validate all entries before creating anything. Never use extractall.
            for entry in entries:
                destination = (target / entry.filename).resolve()
                if not destination.is_relative_to(target):
                    raise ValueError("Archive leaves destination")
                if entry.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entry) as source, destination.open("xb") as output:
                        remaining = entry.file_size
                        while remaining:
                            chunk = source.read(min(65536, remaining))
                            if not chunk:
                                raise ValueError("Truncated archive member")
                            output.write(chunk)
                            remaining -= len(chunk)
            return {"extracted": True, "destination": request["destination"], "entries": manifest}
        return {"entries": manifest, "totalBytes": sum(entry.file_size for entry in entries)}


def read_document(path, limit):
    kind = path.suffix.lower()
    if kind in (".json", ".jsonl", ".csv", ".tsv"):
        if path.stat().st_size > 10_000_000:
            raise ValueError("Structured data exceeds 10MB")
        with path.open(encoding="utf-8-sig", newline="") as source:
            if kind == ".json":
                return {"data": json.load(source), "format": "json"}
            if kind == ".jsonl":
                rows = []
                for line in source:
                    if line.strip():
                        rows.append(json.loads(line))
                    if len(rows) > 1000:
                        break
                return {"records": rows[:1000], "truncated": len(rows) > 1000, "format": "jsonl"}
            reader = csv.reader(source, delimiter="\t" if kind == ".tsv" else ",")
            rows = []
            for row in reader:
                if len(row) > 1000:
                    raise ValueError("Data exceeds 1000 columns")
                rows.append(row)
                if len(rows) > 1000:
                    break
            return {"rows": rows[:1000], "truncated": len(rows) > 1000, "format": kind[1:]}
    if kind in (".docx", ".xlsx", ".pptx"):
        inspect_zip(path)
    if kind == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(path)
        pages = [{"page": i + 1, "text": (page.extract_text() or "")[:limit]} for i, page in enumerate(reader.pages[:100])]
        return {"pages": pages, "totalPages": len(reader.pages), "truncated": len(reader.pages) > 100}
    if kind == ".docx":
        from docx import Document
        doc = Document(path)
        return {"paragraphs": [p.text for p in doc.paragraphs[:1000]],
                "tables": [[[c.text for c in row.cells[:50]] for row in table.rows[:500]] for table in doc.tables[:20]]}
    if kind == ".xlsx":
        from openpyxl import load_workbook
        book = load_workbook(path, read_only=True, data_only=False, keep_links=False)
        sheets = []
        for sheet in book.worksheets[:20]:
            rows = list(sheet.iter_rows(min_row=1, max_row=min(sheet.max_row or 1, 1000), max_col=min(sheet.max_column or 1, 100), values_only=True))
            sheets.append({"name": sheet.title, "rows": rows, "totalRows": sheet.max_row, "totalColumns": sheet.max_column})
        book.close()
        return {"sheets": sheets, "note": "Formulas preserved; not recalculated"}
    if kind == ".pptx":
        from pptx import Presentation
        slides = Presentation(path).slides
        return {"slides": [{"slide": i + 1, "text": "\n".join(s.text for s in slide.shapes if s.has_text_frame)} for i, slide in enumerate(list(slides)[:100])], "totalSlides": len(slides)}
    if kind in (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"):
        from PIL import Image
        with Image.open(path) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError("Image exceeds 40MP")
        result = subprocess.run(["tesseract", str(path), "stdout", "-l", "eng+chi_sim"], capture_output=True, text=True, timeout=90, check=True)
        return {"text": result.stdout[:limit], "method": "OCR", "requiresVerification": True}
    return {"text": path.read_text()[:limit]}


def create_document(path, content):
    kind = path.suffix.lower()
    path.parent.mkdir(parents=True, exist_ok=True)
    from document_layout import create_docx, create_xlsx, create_pptx, create_pdf
    creators = {".docx": create_docx, ".xlsx": create_xlsx, ".pptx": create_pptx, ".pdf": create_pdf}
    if kind not in creators:
        raise ValueError("Create supports .docx, .xlsx, .pptx and .pdf")
    creators[kind](path, content, safe_path)
    return {"path": str(path.relative_to(Path.cwd())), "bytes": path.stat().st_size, "created": True}


if __name__ == "__main__":
    request = json.loads(base64.b64decode(sys.argv[2]) if sys.argv[1] == "--base64" else sys.argv[1])
    path = safe_path(request["path"])
    if request["action"].startswith("archive_"):
        result = archive_operation(request)
    elif request["action"] == "create":
        result = create_document(path, request["content"])
    elif request["action"] == "render":
        from document_layout import render_document
        result = render_document(path, safe_path)
    elif request["action"] == "read":
        result = read_document(path, 30000)
    else:
        raise ValueError("Unknown document action")
    serialized = json.dumps(result, ensure_ascii=False, default=str)
    # A valid JSON envelope always exposes any truncation explicitly.
    print(json.dumps({"result": result} if len(serialized) <= 30000 else {
        "truncated": True, "totalChars": len(serialized), "preview": serialized[:30000]}, ensure_ascii=False, default=str))
