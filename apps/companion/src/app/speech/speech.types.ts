/**
 * Speech adapter contracts. The talk flow depends only on these interfaces, so a cloud
 * recogniser or speaker can be added later without touching the talk screen.
 */

/** Language for both recognition and speech. */
export const SPEECH_LANG = 'uk-UA';

/** Listening ends on its own this long after it started (no always-on microphone). */
export const LISTEN_TIMEOUT_MS = 10_000;

export type RecognizerErrorCode = 'unsupported' | 'not-allowed' | 'no-speech' | 'network' | 'aborted' | 'other';

export type RecognizerEvent =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: RecognizerErrorCode }
  | { type: 'end' };

export interface SpeechRecognizer {
  isSupported(): boolean;
  /** Opens the microphone for one question. Must be called from a user gesture; nothing else may call it. */
  start(onEvent: (event: RecognizerEvent) => void): void;
  /** Finish listening and deliver what was heard. */
  stop(): void;
  /** Close the microphone and discard what was heard. */
  abort(): void;
}

export interface SpeechSpeaker {
  isSupported(): boolean;
  /** True once the voices have loaded and one of them has a language starting with 'uk'. */
  hasVoice(): boolean;
  /** Call inside the tap so that later speech is allowed by the browser. */
  prime(): void;
  /** Queues one utterance; resolves when it ends or is cancelled. Never rejects. */
  speak(text: string): Promise<void>;
  cancel(): void;
  speaking(): boolean;
}
