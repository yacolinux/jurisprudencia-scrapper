#!/usr/bin/env python3
"""Create rasterized, visibly redacted review copies of the demo PDFs."""

from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "screenshots"
OUTPUT_DIR = SOURCE_DIR / "censurados"

# Coordinates are based on the 850 x 1200 review render. They cover the
# evidence cards, document lists and source links containing case identifiers.
REDACTIONS = {
    1: [(515, 860, 775, 1200)],
    2: [(75, 335, 515, 560), (75, 1070, 515, 1200)],
    3: [(75, 0, 515, 310)],
}


def render_pages(source: Path, directory: Path) -> list[Path]:
    prefix = directory / "page"
    subprocess.run(
        ["pdftoppm", "-r", "200", "-png", str(source), str(prefix)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return sorted(directory.glob("page-*.png"))


def redact_image(image_path: Path, page_number: int) -> Image.Image:
    image = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(image)
    scale_x = image.width / 850
    scale_y = image.height / 1200
    for x1, y1, x2, y2 in REDACTIONS.get(page_number, []):
        draw.rectangle(
            (round(x1 * scale_x), round(y1 * scale_y), round(x2 * scale_x), round(y2 * scale_y)),
            fill=(0, 0, 0),
        )
    return image


def write_pdf(images: list[Image.Image], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    page_width, page_height = A4
    pdf = canvas.Canvas(str(output), pagesize=A4, pageCompression=1)
    for image in images:
        pdf.drawImage(ImageReader(image), 0, 0, width=page_width, height=page_height, preserveAspectRatio=False)
        pdf.showPage()
    pdf.save()


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sources = sorted(SOURCE_DIR.glob("ej *.pdf"))
    if not sources:
        raise SystemExit("No se encontraron PDFs de ejemplo en screenshots/")
    for source in sources:
        with tempfile.TemporaryDirectory(prefix="pdf-redact-") as temp:
            pages = render_pages(source, Path(temp))
            images = [redact_image(page, index) for index, page in enumerate(pages, start=1)]
            output = OUTPUT_DIR / f"{source.stem} - censurado.pdf"
            write_pdf(images, output)
            print(output)


if __name__ == "__main__":
    main()
