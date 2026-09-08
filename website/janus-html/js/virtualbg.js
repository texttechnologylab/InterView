let segmenter = null;
let canvas = null;
let ctx = null;
let canvasStream = null;
let rafId = null;
let sourceVideo = null;
let currentMode = 'none'; // 'none' | 'blur' | 'image'
let bgImage = null;
let bgImageSrc = null;
let active = false;
let lastProcessedTime = -1;
let framesDrawn = 0;

// Safari < 18 (incl. iPadOS/iOS 17) has no CanvasRenderingContext2D.filter — the
// 'blur(16px)' assignment is silently ignored, the background layer is drawn
// sharp, and blur mode looks like it does nothing. Detect via the prototype
// (assigning to the context and reading back would false-positive: the expando
// property sticks even when unsupported).
const CANVAS_FILTER_SUPPORTED = typeof CanvasRenderingContext2D !== 'undefined'
	&& ('filter' in CanvasRenderingContext2D.prototype);

// Confidence values below this are treated as background (hard cutoff before EMA).
const CONFIDENCE_CUTOFF = 0.70;
// Temporal smoothing: exponential moving average of the person-confidence mask.
// Higher = more stable/sluggish, lower = more responsive/noisy.
const SMOOTH_ALPHA = 0.25;
let smoothedMask = null; // Float32Array, same length as pixel count

export const BG_MODES = {
	none:  { label: 'Kein Hintergrund', icon: 'fa-ban' },
	blur:  { label: 'Unschärfe',        icon: 'fa-droplet' },
	office:{ label: 'VR',               icon: 'fa-building' },
};

export const BG_IMAGES = {
	office: '/dependencies/backgrounds/office.jpg',
};

export async function warmUpSegmenter() {
	loadSegmenter().catch(() => {});
}

async function loadSegmenter() {
	if (segmenter) {
		console.debug('[VBG] loadSegmenter: reusing existing segmenter');
		return segmenter;
	}

	console.debug('[VBG] loadSegmenter: importing vision_bundle.mjs');
	const { ImageSegmenter, FilesetResolver } = await import(
		'/dependencies/js/vision_bundle.mjs'
	);

	console.debug('[VBG] loadSegmenter: resolving wasm fileset');
	const vision = await FilesetResolver.forVisionTasks(
		'/dependencies/js/wasm'
	);

	console.debug('[VBG] loadSegmenter: creating ImageSegmenter (delegate=GPU)');
	segmenter = await ImageSegmenter.createFromOptions(vision, {
		baseOptions: {
			modelAssetPath: '/dependencies/backgrounds/selfie_segmenter.tflite',
			delegate: 'GPU',
		},
		outputCategoryMask: false,
		outputConfidenceMasks: true,
		runningMode: 'VIDEO',
	});

	console.debug('[VBG] loadSegmenter: segmenter ready');
	return segmenter;
}

// Fallback blur for browsers without ctx.filter: bilinear downscale to a small
// scratch canvas and upscale back — cheap and close enough to a real gaussian
// for a background layer.
let blurCanvas = null;
let blurCtx = null;

function drawBlurFallback(w, h) {
	const bw = Math.max(2, Math.round(w / 12));
	const bh = Math.max(2, Math.round(h / 12));
	if (!blurCanvas) {
		blurCanvas = document.createElement('canvas');
		blurCtx = blurCanvas.getContext('2d');
	}
	if (blurCanvas.width !== bw || blurCanvas.height !== bh) {
		blurCanvas.width = bw;
		blurCanvas.height = bh;
	}
	blurCtx.drawImage(sourceVideo, 0, 0, bw, bh);
	ctx.drawImage(blurCanvas, 0, 0, bw, bh, 0, 0, w, h);
}

function ensureCanvas(w, h) {
	if (!canvas) {
		canvas = document.createElement('canvas');
		ctx = canvas.getContext('2d', { willReadFrequently: false });
	}
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
	}
}

function drawFrame() {
	if (!active || !sourceVideo || sourceVideo.readyState < 2) {
		rafId = requestAnimationFrame(drawFrame);
		return;
	}

	const w = sourceVideo.videoWidth;
	const h = sourceVideo.videoHeight;
	if (!w || !h) {
		rafId = requestAnimationFrame(drawFrame);
		return;
	}

	ensureCanvas(w, h);

	// Skip if the video hasn't produced a new frame yet
	if (sourceVideo.currentTime === lastProcessedTime) {
		rafId = requestAnimationFrame(drawFrame);
		return;
	}
	lastProcessedTime = sourceVideo.currentTime;

	const now = performance.now();
	const result = segmenter.segmentForVideo(sourceVideo, now);
	const confidenceMask = result.confidenceMasks?.[0];

	if (!confidenceMask) {
		ctx.drawImage(sourceVideo, 0, 0, w, h);
		confidenceMask && confidenceMask.close();
		rafId = requestAnimationFrame(drawFrame);
		return;
	}

	// confidence: float 0–1 where 1 = definitely person, 0 = definitely background
	const rawConfidence = confidenceMask.getAsFloat32Array();
	confidenceMask.close();

	// Hard cutoff then EMA smoothing — kills low-confidence pixels (chair edges etc.)
	const n = rawConfidence.length;
	if (!smoothedMask || smoothedMask.length !== n) {
		smoothedMask = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			smoothedMask[i] = rawConfidence[i] < CONFIDENCE_CUTOFF ? 0 : rawConfidence[i];
		}
	} else {
		for (let i = 0; i < n; i++) {
			const v = rawConfidence[i] < CONFIDENCE_CUTOFF ? 0 : rawConfidence[i];
			smoothedMask[i] = SMOOTH_ALPHA * v + (1 - SMOOTH_ALPHA) * smoothedMask[i];
		}
	}

	// Draw sharp camera frame — we'll read it as the person source
	ctx.drawImage(sourceVideo, 0, 0, w, h);
	const frame = ctx.getImageData(0, 0, w, h);

	// Build background layer (blurred video or bg image)
	if (currentMode === 'blur') {
		if (framesDrawn === 0) {
			console.debug('[VBG] blur path:', CANVAS_FILTER_SUPPORTED
				? 'native ctx.filter' : 'downscale fallback (ctx.filter unsupported)');
		}
		if (CANVAS_FILTER_SUPPORTED) {
			ctx.save();
			ctx.filter = 'blur(16px)';
			ctx.drawImage(sourceVideo, 0, 0, w, h);
			ctx.filter = 'none';
			ctx.restore();
		} else {
			drawBlurFallback(w, h);
		}
	} else if (currentMode !== 'none' && bgImage && bgImage.complete) {
		ctx.drawImage(bgImage, 0, 0, w, h);
	} else {
		ctx.putImageData(frame, 0, 0);
		rafId = requestAnimationFrame(drawFrame);
		return;
	}

	const bgFrame = ctx.getImageData(0, 0, w, h);

	// Alpha-blend: person confidence drives how much of the sharp camera frame shows.
	// Feathering comes for free because confidence is continuous, not binary.
	for (let i = 0; i < n; i++) {
		const alpha = smoothedMask[i]; // 1 = full person, 0 = full background
		const p = i * 4;
		bgFrame.data[p]     = alpha * frame.data[p]     + (1 - alpha) * bgFrame.data[p];
		bgFrame.data[p + 1] = alpha * frame.data[p + 1] + (1 - alpha) * bgFrame.data[p + 1];
		bgFrame.data[p + 2] = alpha * frame.data[p + 2] + (1 - alpha) * bgFrame.data[p + 2];
	}
	ctx.putImageData(bgFrame, 0, 0);

	framesDrawn++;
	if (framesDrawn <= 3 || framesDrawn % 300 === 0) {
		console.debug('[VBG] drawFrame: composited frame #', framesDrawn, 'mode=', currentMode, w + 'x' + h);
	}

	rafId = requestAnimationFrame(drawFrame);
}

export async function startVirtualBg(rawVideoTrack, mode) {
	console.debug('[VBG] startVirtualBg: mode=', mode, 'rawTrack readyState=', rawVideoTrack && rawVideoTrack.readyState);
	currentMode = mode || 'blur';

	if (currentMode !== 'none' && currentMode !== 'blur' && BG_IMAGES[currentMode]) {
		if (bgImageSrc !== BG_IMAGES[currentMode]) {
			bgImage = new Image();
			bgImageSrc = BG_IMAGES[currentMode];
			bgImage.src = bgImageSrc;
		}
	}

	await loadSegmenter();

	// Wire raw track → hidden video element → canvas loop
	const stream = new MediaStream([rawVideoTrack]);
	if (!sourceVideo) {
		sourceVideo = document.createElement('video');
		sourceVideo.muted = true;
		sourceVideo.playsInline = true;
	}
	sourceVideo.srcObject = stream;
	console.debug('[VBG] startVirtualBg: awaiting sourceVideo.play()');
	await sourceVideo.play();
	console.debug('[VBG] startVirtualBg: sourceVideo.play() resolved, videoW=', sourceVideo.videoWidth, 'videoH=', sourceVideo.videoHeight);

	const w = rawVideoTrack.getSettings().width  || 1280;
	const h = rawVideoTrack.getSettings().height || 720;
	ensureCanvas(w, h);

	smoothedMask = null;
	lastProcessedTime = -1;
	framesDrawn = 0;
	active = true;
	if (rafId) cancelAnimationFrame(rafId);
	rafId = requestAnimationFrame(drawFrame);

	canvasStream = canvas.captureStream(30);
	const outTrack = canvasStream.getVideoTracks()[0];
	console.debug('[VBG] startVirtualBg: captureStream done, outTrack=', !!outTrack, outTrack ? ('readyState=' + outTrack.readyState + ' muted=' + outTrack.muted) : '');
	return outTrack;
}

export function setVirtualBgMode(mode) {
	currentMode = mode;
	if (mode !== 'none' && mode !== 'blur' && BG_IMAGES[mode]) {
		if (bgImageSrc !== BG_IMAGES[mode]) {
			bgImage = new Image();
			bgImageSrc = BG_IMAGES[mode];
			bgImage.src = bgImageSrc;
		}
	}
}

export function stopVirtualBg() {
	console.debug('[VBG] stopVirtualBg: tearing down (was active=', active, ')');
	active = false;
	if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
	if (sourceVideo) {
		// Stop the raw camera track that was feeding the canvas — otherwise the
		// camera stays held by an orphaned track and the next getUserMedia fails.
		const srcStream = sourceVideo.srcObject;
		if (srcStream && typeof srcStream.getTracks === 'function') {
			srcStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
		}
		sourceVideo.srcObject = null;
	}
	if (canvasStream) { canvasStream.getTracks().forEach(t => t.stop()); canvasStream = null; }
	// Keep the segmenter alive — re-creating it on every VBG toggle costs ~1–2s of
	// WASM import + GPU pipeline init. The segmenter holds no per-session state and
	// is safe to reuse across toggles.
	canvas = null;
	ctx = null;
	blurCanvas = null;
	blurCtx = null;
}

export function isVirtualBgActive() {
	return active;
}
