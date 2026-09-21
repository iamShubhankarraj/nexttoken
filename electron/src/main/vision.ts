/**
 * vision.ts — real on-device vision: screen capture → vision model → text.
 *
 * describeScreen() is the single entry point for "what's on my screen"
 * style requests. It captures the primary display with desktopCapturer,
 * feeds the PNG to the vision slot via the ModelRouter, and returns the
 * description. When the vision slot is empty ('none') the router raises
 * VisionRequiredError — callers turn that into the "download a vision
 * model" notice + model-manager nudge instead of hallucinating.
 *
 * Runs entirely in the main process; the capture + model call are async
 * and never block the renderer or the voice pipeline.
 */

import { desktopCapturer } from 'electron';
import { ModelRouter, type RouterDeps } from './models/router';
import { VisionRequiredError } from './models/task-models';
import type { LlmImage } from './agent/llm';

/** Capture width: enough detail for a VLM, small enough to stay fast. */
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 800;

export async function captureScreenImage(): Promise<LlmImage> {
  let sources: Electron.DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT }
    });
  } catch (e) {
    throw new Error(
      `Could not capture the screen: ${e instanceof Error ? e.message : String(e)}. ` +
        'On macOS, grant Screen Recording permission in System Settings → Privacy & Security.'
    );
  }
  // Prefer the primary display when the source id names it; else the first.
  const src =
    sources.find((s) => /screen:\d+:0$/.test(s.id)) ??
    sources.find((s) => s.id.startsWith('screen')) ??
    sources[0];
  if (!src || src.thumbnail.isEmpty()) {
    throw new Error(
      'Screen capture came back blank. Grant Screen Recording permission in ' +
        'System Settings → Privacy & Security → Screen Recording, then try again.'
    );
  }
  return { data: src.thumbnail.toPNG().toString('base64'), mimeType: 'image/png' };
}

/**
 * Describe what's on the screen with the vision-slot model.
 * Throws VisionRequiredError when no vision model is downloaded.
 */
export async function describeScreen(
  routerDeps: RouterDeps,
  question: string,
  signal?: AbortSignal
): Promise<{ text: string; via: string }> {
  // Resolve the slot FIRST so a missing vision model fails fast, before we
  // spend time capturing the screen.
  const router = new ModelRouter(routerDeps);
  const image = await captureScreenImage();
  const focus = question.trim() || "Describe what is visible on the screen.";
  const r = await router.complete({
    task: 'vision',
    messages: [
      {
        role: 'system',
        content:
          'You are the eyes of the Next Token browser. Look at the screenshot and ' +
          'answer the user briefly and conversationally — this will be spoken aloud. ' +
          'Describe what matters for their question; keep it under 100 words unless ' +
          'they asked for detail. Never invent things that are not visible.'
      },
      { role: 'user', content: focus, images: [image] }
    ],
    signal
  });
  if (r.text.trim().length === 0) {
    throw new Error('The vision model returned an empty description.');
  }
  return { text: r.text.trim(), via: r.via };
}

export { VisionRequiredError };
