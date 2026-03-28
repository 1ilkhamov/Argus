import { useState, useRef, useCallback } from 'react';

export type VoiceRecorderState = 'idle' | 'recording' | 'sending';

interface UseVoiceRecorderOptions {
  onRecorded: (blob: Blob) => Promise<void>;
  onError?: (message: string) => void;
}

export function useVoiceRecorder({ onRecorded, onError }: UseVoiceRecorderOptions) {
  const [state, setState] = useState<VoiceRecorderState>('idle');
  const [duration, setDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setDuration(0);
  }, []);

  const startRecording = useCallback(async () => {
    if (state !== 'idle') return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        cleanup();

        if (blob.size < 100) {
          setState('idle');
          return;
        }

        setState('sending');
        try {
          await onRecorded(blob);
        } finally {
          setState('idle');
        }
      };

      recorder.start(250); // collect chunks every 250ms
      setState('recording');

      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } catch (err) {
      cleanup();
      setState('idle');
      const msg = err instanceof Error ? err.message : 'Microphone access denied';
      onError?.(msg);
    }
  }, [state, onRecorded, onError, cleanup]);

  const stopRecording = useCallback(() => {
    if (state !== 'recording' || !mediaRecorderRef.current) return;
    mediaRecorderRef.current.stop();
  }, [state]);

  const cancelRecording = useCallback(() => {
    if (state !== 'recording' || !mediaRecorderRef.current) return;
    mediaRecorderRef.current.ondataavailable = null;
    mediaRecorderRef.current.onstop = null;
    mediaRecorderRef.current.stop();
    cleanup();
    setState('idle');
  }, [state, cleanup]);

  return {
    state,
    duration,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
