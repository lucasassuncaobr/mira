import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { createWorker } from "tesseract.js";

GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.worker.mjs";

let cvReady: Promise<void> | null = null;
let tessWorker: Awaited<ReturnType<typeof createWorker>> | null = null;

async function ensureCV(): Promise<void> {
  if (cvReady) return cvReady;
  cvReady = (async () => {
    await import("@techstark/opencv-js");
  })();
  return cvReady;
}

async function getTessWorker() {
  if (tessWorker) return tessWorker;
  tessWorker = await createWorker("por");
  return tessWorker;
}

function preprocessWithOpenCV(source: HTMLCanvasElement): HTMLCanvasElement {
  const cv = (window as any).cv;
  const src = cv.imread(source);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const binary = new cv.Mat();
  cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let angle = 0;
  if (contours.size() > 0) {
    let maxArea = 0;
    let maxContour: any = null;
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (area > maxArea) {
        maxArea = area;
        maxContour = contours.get(i);
      }
    }
    if (maxContour && maxArea > 1000) {
      const rect = cv.minAreaRect(maxContour);
      angle = rect.angle;
      if (angle < -45) angle += 90;
    }
    if (maxContour) maxContour.delete();
  }
  contours.delete();
  hierarchy.delete();

  let result = binary;
  if (Math.abs(angle) > 0.5) {
    const center = new cv.Point(binary.cols / 2, binary.rows / 2);
    const rotMatrix = cv.getRotationMatrix2D(center, angle, 1);
    const rotated = new cv.Mat();
    cv.warpAffine(binary, rotated, rotMatrix, binary.size(), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    const out = document.createElement("canvas");
    cv.imshow(out, rotated);
    rotated.delete();
    rotMatrix.delete();
    result = rotated;
  }

  if (result !== binary) {
    const out = document.createElement("canvas");
    cv.imshow(out, result);
    src.delete();
    gray.delete();
    binary.delete();
    return out;
  }

  const out = document.createElement("canvas");
  cv.imshow(out, binary);
  src.delete();
  gray.delete();
  binary.delete();
  return out;
}

export async function ocrPdf(file: File, onProgress?: (current: number, total: number) => void): Promise<string> {
  await ensureCV();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: arrayBuffer }).promise;

  const totalPages = pdf.numPages;
  let text = "";

  for (let i = 1; i <= totalPages; i++) {
    onProgress?.(i, totalPages);

    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvas: canvas, viewport }).promise;

    const content = await page.getTextContent();
    const nativeText = content.items.map((item: any) => item.str).join(" ");
    if (nativeText.trim().length > 80) {
      text += `\n[[PAGE:${i}]]\n${nativeText}`;
      continue;
    }

    const processed = preprocessWithOpenCV(canvas);

    const worker = await getTessWorker();
    const { data } = await worker.recognize(processed);

    text += `\n[[PAGE:${i}]]\n${data.text}`;
  }

  return text;
}
