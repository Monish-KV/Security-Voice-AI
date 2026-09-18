#!/usr/bin/env python3
"""
VoiceShield AI Speech-to-Text Transcription Service
Application-layer speech transcription utility.
Does NOT modify or interfere with Keras deepfake models or inference.
"""

import sys
import io
import json
import subprocess
import speech_recognition as sr

def transcribe_audio_bytes(audio_bytes):
    if not audio_bytes or len(audio_bytes) < 64:
        return {
            "success": False,
            "transcript": "TRANSCRIPTION UNAVAILABLE",
            "error": "Audio payload too short or empty"
        }
    
    # Convert input audio stream to 16kHz mono 16-bit PCM WAV via ffmpeg
    try:
        proc = subprocess.Popen(
            [
                "ffmpeg", "-v", "error", "-y",
                "-i", "pipe:0",
                "-ar", "16000",
                "-ac", "1",
                "-f", "wav",
                "pipe:1"
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        wav_data, ffmpeg_err = proc.communicate(input=audio_bytes, timeout=12)
        if proc.returncode != 0 or not wav_data:
            return {
                "success": False,
                "transcript": "TRANSCRIPTION UNAVAILABLE",
                "error": f"Audio decode failed: {ffmpeg_err.decode('utf-8', errors='ignore')[:150]}"
            }
    except Exception as e:
        return {
            "success": False,
            "transcript": "TRANSCRIPTION UNAVAILABLE",
            "error": f"FFmpeg processing error: {str(e)}"
        }

    # Transcribe via SpeechRecognition
    recognizer = sr.Recognizer()
    try:
        with sr.AudioFile(io.BytesIO(wav_data)) as source:
            # Adjust for ambient noise slightly if needed
            audio_source = recognizer.record(source)
            text = recognizer.recognize_google(audio_source)
            if text and text.strip():
                return {
                    "success": True,
                    "transcript": text.strip(),
                    "technology": "Google Speech Recognition"
                }
            else:
                return {
                    "success": False,
                    "transcript": "TRANSCRIPTION UNAVAILABLE",
                    "error": "No speech detected"
                }
    except sr.UnknownValueError:
        # Speech was unintelligible or silent or sine wave
        return {
            "success": False,
            "transcript": "TRANSCRIPTION UNAVAILABLE",
            "error": "Speech unintelligible or silence"
        }
    except sr.RequestError as e:
        return {
            "success": False,
            "transcript": "TRANSCRIPTION UNAVAILABLE",
            "error": f"STT network error: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "transcript": "TRANSCRIPTION UNAVAILABLE",
            "error": f"Transcription error: {str(e)}"
        }

def main():
    if len(sys.argv) > 1 and sys.argv[1] not in ("-", "--stdin"):
        # Reading from a file path
        filepath = sys.argv[1]
        try:
            with open(filepath, "rb") as f:
                data = f.read()
        except Exception as e:
            print(json.dumps({
                "success": False,
                "transcript": "TRANSCRIPTION UNAVAILABLE",
                "error": str(e)
            }))
            sys.exit(0)
    else:
        # Reading binary data from stdin
        data = sys.stdin.buffer.read()

    result = transcribe_audio_bytes(data)
    print(json.dumps(result))

if __name__ == "__main__":
    main()
