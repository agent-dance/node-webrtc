import 'dart:math' as math;
import 'dart:ui' as ui;
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class VideoReceiverHandler extends ChangeNotifier {
  int framesReceived = 0;
  int framesDropped = 0;
  int fps = 0;
  DateTime? startTime;
  int _fpsCounter = 0;

  final ValueNotifier<ui.Image?> currentFrame = ValueNotifier(null);

  bool _decoding = false;

  void handleChannel(RTCDataChannel channel) {
    debugPrint('[Video] Channel ready');
    startTime = DateTime.now();

    // FPS counter
    _startFpsCounter();

    channel.onMessage = (RTCDataChannelMessage message) {
      if (message.isBinary) {
        _handleFrame(message.binary);
      }
    };

    channel.onDataChannelState = (RTCDataChannelState state) {
      debugPrint('[Video] State: $state');
    };
  }

  void _handleFrame(Uint8List data) {
    // Frame format: [4B frameId][4B w][4B h][8B ts_ms][w*h*4 RGBA]
    if (data.length < 20) return;

    final bd = ByteData.sublistView(data);
    final frameId = bd.getUint32(0, Endian.big);
    final w = bd.getUint32(4, Endian.big);
    final h = bd.getUint32(8, Endian.big);

    // If already decoding, drop frame to maintain real-time
    if (_decoding) {
      framesDropped++;
      notifyListeners();
      return;
    }

    _decoding = true;
    final expected = 20 + w * h * 4;
    final pixels =
        data.length >= expected ? data.sublist(20, expected) : _renderFrame(frameId, w, h);

    ui.decodeImageFromPixels(
      pixels,
      w,
      h,
      ui.PixelFormat.rgba8888,
      (img) {
        currentFrame.value = img;
        framesReceived++;
        _fpsCounter++;
        _decoding = false;
        notifyListeners();
      },
    );
  }

  Uint8List _renderFrame(int frameId, int width, int height) {
    final pixels = Uint8List(width * height * 4);
    final hueBase = (frameId * 2) % 360;
    final scanLine = frameId % height;

    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        final idx = (y * width + x) * 4;
        final hue = (hueBase + (x + y) * 0.5) % 360;
        final value =
            y == scanLine ? 1.0 : 0.6 + 0.2 * math.sin((x + frameId * 3) * 0.05);
        final rgb = _hsvToRgb(hue, 0.8, value);

        pixels[idx] = rgb.$1;
        pixels[idx + 1] = rgb.$2;
        pixels[idx + 2] = rgb.$3;
        pixels[idx + 3] = 255;
      }
    }

    return pixels;
  }

  (int, int, int) _hsvToRgb(double hue, double saturation, double value) {
    final chroma = value * saturation;
    final x = chroma * (1 - ((hue / 60) % 2 - 1).abs());
    final match = value - chroma;
    var red = 0.0;
    var green = 0.0;
    var blue = 0.0;

    if (hue < 60) {
      red = chroma;
      green = x;
    } else if (hue < 120) {
      red = x;
      green = chroma;
    } else if (hue < 180) {
      green = chroma;
      blue = x;
    } else if (hue < 240) {
      green = x;
      blue = chroma;
    } else if (hue < 300) {
      red = x;
      blue = chroma;
    } else {
      red = chroma;
      blue = x;
    }

    return (
      ((red + match) * 255).round(),
      ((green + match) * 255).round(),
      ((blue + match) * 255).round(),
    );
  }

  void _startFpsCounter() {
    Future.doWhile(() async {
      await Future.delayed(const Duration(seconds: 1));
      fps = _fpsCounter;
      _fpsCounter = 0;
      notifyListeners();
      return true;
    });
  }

  @override
  void dispose() {
    currentFrame.dispose();
    super.dispose();
  }
}
