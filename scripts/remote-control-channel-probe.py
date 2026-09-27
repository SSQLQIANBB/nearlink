"""Pinned-SDK loopback regression: real DCEP plus immediate first messages, no media/input."""
import base64
import importlib.util
import json
from pathlib import Path
import queue
import tempfile
import threading

spec = importlib.util.spec_from_file_location('host_engine', Path(__file__).with_name('remote-control-host-engine.py'))
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)

with tempfile.TemporaryDirectory(prefix='todesk-channel-probe-') as directory:
    GLib, Gst, SDP, WebRTC, sdk = engine.load_sdk(str(Path(directory) / 'registry.bin'))
    loop = GLib.MainLoop()
    receiver = object.__new__(engine.Engine)
    receiver.WebRTC, receiver.channels = WebRTC, {}
    receiver.pending, receiver.closed = queue.Queue(engine.MAX_PENDING), threading.Event()
    events, errors, preparing = [], [], []
    def fail(code):
        errors.append(code)
        receiver.closed.set()
        GLib.idle_add(loop.quit)
    receiver.fail = fail
    def send(kind, payload):
        events.append((kind, payload))
        if sum(k == 'channel-data' for k, _ in events) == 2:
            loop.quit()
    receiver.send = send
    peers = [Gst.ElementFactory.make('webrtcbin') for _ in range(2)]
    bindings = [engine.bind_loopback(peer, sdk) for peer in peers]
    a, b = peers
    for peer, remote in [(a,b), (b,a)]:
        peer.connect('on-ice-candidate', lambda _p, index, candidate, target=remote:
                     target.emit('add-ice-candidate', index, candidate) if candidate else None)
    def prepare(peer, channel, local):
        preparing.append(channel.get_property('label'))
        receiver.prepare_channel(peer, channel, local)
    b.connect('prepare-data-channel', prepare)
    for peer in peers:
        peer.set_state(Gst.State.PLAYING)
    channels = []
    for label in sorted(engine.LABELS):
        channel = a.emit('create-data-channel', label, None)
        channel.connect('on-open', lambda c, value=label: c.emit('send-string', 'immediate-' + value))
        channels.append(channel)
    def answer_ready(promise, *_):
        reply = promise.get_reply()
        answer = reply.get_value('answer').copy()
        b.emit('set-local-description', answer, Gst.Promise.new())
        a.emit('set-remote-description', answer, Gst.Promise.new())
    def offer_ready(promise, *_):
        reply = promise.get_reply()
        offer = reply.get_value('offer').copy()
        a.emit('set-local-description', offer, Gst.Promise.new())
        b.emit('set-remote-description', offer, Gst.Promise.new())
        b.emit('create-answer', None, Gst.Promise.new_with_change_func(answer_ready, None, None))
    a.emit('create-offer', None, Gst.Promise.new_with_change_func(offer_ready, None, None))
    GLib.timeout_add(100, receiver.drain)
    GLib.timeout_add_seconds(15, lambda: fail('TIMEOUT'))
    try:
        loop.run()
        assert not errors, errors
        assert len(preparing) == 2 and all(label in (None, '') for label in preparing), preparing
        for label in engine.LABELS:
            opened = events.index(('channel-open', {'label': label}))
            received = next(i for i, (kind, payload) in enumerate(events)
                            if kind == 'channel-data' and payload['label'] == label)
            assert opened < received
            raw = events[received][1]['data']
            assert base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)).decode() == 'immediate-' + label
        print(json.dumps({'passed': True, 'actualDcep': True, 'immediateMessages': 2,
                          'emptyMetadataAtPrepare': True, 'mediaStarted': False, 'osInput': False}))
    finally:
        receiver.closed.set()
        for peer in peers:
            peer.set_state(Gst.State.NULL)
