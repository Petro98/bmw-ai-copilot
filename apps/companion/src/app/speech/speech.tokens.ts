import { InjectionToken } from '@angular/core';
import { BrowserSpeechRecognizer, RecognitionWindow } from './browser-recognizer';
import { BrowserSpeechSpeaker, SpeakerWindow } from './browser-speaker';
import { SpeechRecognizer, SpeechSpeaker } from './speech.types';

/** The browser globals, or nothing when there is no window (the adapters then report unsupported). */
function browserWindow(): RecognitionWindow & SpeakerWindow {
  return typeof window === 'undefined' ? {} : (window as unknown as RecognitionWindow & SpeakerWindow);
}

/** Free path: the browser's own recognition. Provide another implementation to use a cloud recogniser. */
export const SPEECH_RECOGNIZER = new InjectionToken<SpeechRecognizer>('SPEECH_RECOGNIZER', {
  providedIn: 'root',
  factory: () => new BrowserSpeechRecognizer(browserWindow()),
});

/** Free path: the browser's own speech synthesis. Provide another implementation to use a cloud speaker. */
export const SPEECH_SPEAKER = new InjectionToken<SpeechSpeaker>('SPEECH_SPEAKER', {
  providedIn: 'root',
  factory: () => new BrowserSpeechSpeaker(browserWindow()),
});
