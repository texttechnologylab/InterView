/* global Janus:readonly */

export const ROLE = window.INTERVIEW_ROLE || 'interviewee';
export const IS_INTERVIEWER = ROLE === 'interviewer';

export const ANSWER_OPTIONS_ALLOWED_ORIGINS = [];

export function roomIdFromString(s) {
	const str = String(s).trim();
	if (/^\d+$/.test(str)) return parseInt(str, 10);
	let h = 5381;
	for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) | 0;
	return Math.abs(h) || 1;
}

export function getQueryStringValue(name) {
	const m = new RegExp("[?&]" + name + "=([^&#]*)", "i").exec(location.search);
	return m === null ? "" : decodeURIComponent(m[1].replace(/\+/g, " "));
}

const rawId = getQueryStringValue("ID") || getQueryStringValue("room");
if (!rawId) {
	window.location.href = "/";
}

export const myroom = roomIdFromString(rawId);
export const myroomLabel = String(rawId);

export const state = {
	janus: null,
	sfutest: null,
	textHandle: null,
	remoteFeed: null,
	opaqueId: "interview-" + Janus.randomString(12),
	myusername: IS_INTERVIEWER ? 'Interviewer:in' : 'Teilnehmer:in',
	myDisplayId: null,
	myid: null,
	mypvtid: null,
	recording: false,
	chatReady: false,
	pendingAnswerOptions: null,
	feedStreams: {},
	subStreams: {},
	slots: {},
	mids: {},
	subscriptions: {},
	feeds: {},
	localTracks: {},
	localVideos: 0,
	activeLocalAudioTrackId: '',
	activeLocalVideoTrackId: '',
	remoteTracks: {},
	textTransactions: {},
	audioUnlocked: false,
	selectedAudioDeviceId: '',
	selectedVideoDeviceId: '',
	selectedOutputDeviceId: '',
	virtualBgMode: IS_INTERVIEWER ? 'office' : 'none',
	preinterviewStream: null,
	cameraEnabled: true,
	videoTrackPublished: false
};
