package com.xiyou.answerhelper;

import android.app.Activity;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.media.ToneGenerator;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;

/** 音频播放 + WAV 录音（作答用） */
public final class MediaController {
    private static final int SAMPLE_RATE = 16000;

    private final Activity activity;
    private MediaPlayer player;
    private AudioRecord audioRecord;
    private Thread recordThread;
    private File recordFile;
    private volatile boolean recording;
    private long recordStart;
    private int recordLimit;
    private Runnable onPlayDone;
    private ToneGenerator toneGen;

    public MediaController(Activity activity) {
        this.activity = activity;
    }

    /** 录音提示音（叮） */
    public void beep() {
        try {
            if (toneGen == null) toneGen = new ToneGenerator(AudioManager.STREAM_MUSIC, 90);
            toneGen.startTone(ToneGenerator.TONE_PROP_BEEP, 200);
        } catch (Throwable ignored) {
        }
    }

    public void setOnPlayDone(Runnable r) {
        this.onPlayDone = r;
    }

    // ---------------- 播放 ----------------

    public synchronized void play(String url) {
        stopPlay();
        if (url == null || url.isEmpty()) return;
        try {
            player = new MediaPlayer();
            player.setAudioStreamType(AudioManager.STREAM_MUSIC);
            player.setDataSource(url);
            player.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override
                public void onPrepared(MediaPlayer mp) {
                    try {
                        mp.start();
                    } catch (Throwable ignored) {
                    }
                }
            });
            player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer mp) {
                    stopPlay();
                    if (onPlayDone != null) {
                        try {
                            onPlayDone.run();
                        } catch (Throwable ignored) {
                        }
                    }
                }
            });
            player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override
                public boolean onError(MediaPlayer mp, int what, int extra) {
                    stopPlay();
                    return true;
                }
            });
            player.prepareAsync();
        } catch (Throwable e) {
            stopPlay();
        }
    }

    public synchronized void playFile(File file) {
        stopPlay();
        if (file == null || !file.exists()) return;
        try {
            player = new MediaPlayer();
            player.setAudioStreamType(AudioManager.STREAM_MUSIC);
            player.setDataSource(file.getAbsolutePath());
            player.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override
                public void onPrepared(MediaPlayer mp) {
                    try {
                        mp.start();
                    } catch (Throwable ignored) {
                    }
                }
            });
            player.prepare();
        } catch (Throwable e) {
            stopPlay();
        }
    }

    public synchronized void stopPlay() {
        if (player != null) {
            try {
                player.stop();
            } catch (Throwable ignored) {
            }
            try {
                player.release();
            } catch (Throwable ignored) {
            }
            player = null;
        }
    }

    // ---------------- 录音（WAV） ----------------

    public synchronized void startRecord(int seconds) throws Exception {
        stopRecordInternal();
        File dir = new File(activity.getCacheDir(), "rec");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建录音目录");
        recordFile = new File(dir, "answer_" + System.currentTimeMillis() + ".wav");

        int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int bufSize = Math.max(minBuf > 0 ? minBuf : 4096, SAMPLE_RATE);
        audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize);
        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            try {
                audioRecord.release();
            } catch (Throwable ignored) {
            }
            audioRecord = null;
            throw new Exception("麦克风不可用");
        }

        final FileOutputStream fos = new FileOutputStream(recordFile);
        fos.write(new byte[44]);
        fos.flush();

        audioRecord.startRecording();
        recording = true;
        recordStart = System.currentTimeMillis();

        recordThread = new Thread(new Runnable() {
            @Override
            public void run() {
                byte[] buf = new byte[3200];
                int total = 0;
                try {
                    while (recording) {
                        int n = audioRecord.read(buf, 0, buf.length);
                        if (n > 0) {
                            fos.write(buf, 0, n);
                            total += n;
                        }
                    }
                } catch (Throwable ignored) {
                }
                try {
                    audioRecord.stop();
                } catch (Throwable ignored) {
                }
                try {
                    audioRecord.release();
                } catch (Throwable ignored) {
                }
                audioRecord = null;
                try {
                    fos.flush();
                    fos.close();
                } catch (Throwable ignored) {
                }
                try {
                    RandomAccessFile raf = new RandomAccessFile(recordFile, "rw");
                    raf.seek(0);
                    raf.write(wavHeader(total));
                    raf.close();
                } catch (Throwable ignored) {
                }
            }
        });
        recordThread.start();
        recordLimit = seconds;
    }

    public synchronized long stopRecord() {
        if (!recording) return 0;
        recording = false;
        Thread t = recordThread;
        recordThread = null;
        if (t != null) {
            try {
                t.join(2000);
            } catch (Throwable ignored) {
            }
        }
        return System.currentTimeMillis() - recordStart;
    }

    private void stopRecordInternal() {
        if (recording) {
            recording = false;
            Thread t = recordThread;
            recordThread = null;
            if (t != null) {
                try {
                    t.join(1500);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /** 44 字节标准 WAV 头 */
    private static byte[] wavHeader(int dataLen) {
        byte[] h = new byte[44];
        int byteRate = SAMPLE_RATE * 2;
        h[0] = 'R';
        h[1] = 'I';
        h[2] = 'F';
        h[3] = 'F';
        putInt(h, 4, 36 + dataLen);
        h[8] = 'W';
        h[9] = 'A';
        h[10] = 'V';
        h[11] = 'E';
        h[12] = 'f';
        h[13] = 'm';
        h[14] = 't';
        h[15] = ' ';
        putInt(h, 16, 16);
        putShort(h, 20, 1);
        putShort(h, 22, 1);
        putInt(h, 24, SAMPLE_RATE);
        putInt(h, 28, byteRate);
        putShort(h, 32, 2);
        putShort(h, 34, 16);
        h[36] = 'd';
        h[37] = 'a';
        h[38] = 't';
        h[39] = 'a';
        putInt(h, 40, dataLen);
        return h;
    }

    private static void putInt(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
        b[off + 2] = (byte) ((v >> 16) & 0xff);
        b[off + 3] = (byte) ((v >> 24) & 0xff);
    }

    private static void putShort(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
    }

    public File getRecordFile() {
        return recordFile;
    }

    public boolean hasRecord() {
        return recordFile != null && recordFile.exists() && recordFile.length() > 44;
    }

    public long recordSize() {
        return hasRecord() ? recordFile.length() : 0;
    }

    public void release() {
        stopPlay();
        stopRecordInternal();
        try {
            if (toneGen != null) toneGen.release();
        } catch (Throwable ignored) {
        }
        toneGen = null;
    }
}
