package proxy

import (
	"encoding/binary"
	"io"
)

type wsFrameParser struct {
	buf []byte
}

func (p *wsFrameParser) Feed(data []byte, onPayload func([]byte)) {
	if len(data) == 0 || p == nil {
		return
	}
	defer func() { recover() }()
	p.buf = append(p.buf, data...)
	for {
		payload, consumed, err := p.consumeOne(onPayload)
		if err != nil || consumed == 0 {
			return
		}
		_ = payload
		if consumed > 0 && consumed <= len(p.buf) {
			p.buf = p.buf[consumed:]
		} else {
			return
		}
	}
}

func (p *wsFrameParser) consumeOne(onPayload func([]byte)) ([]byte, int, error) {
	data := p.buf
	if len(data) < 2 {
		return nil, 0, nil
	}

	opcode := data[0] & 0x0F
	masked := data[1]&0x80 != 0
	payloadLen := int(data[1] & 0x7F)
	offset := 2

	switch payloadLen {
	case 126:
		if len(data) < 4 {
			return nil, 0, nil
		}
		payloadLen = int(binary.BigEndian.Uint16(data[2:4]))
		offset = 4
	case 127:
		if len(data) < 10 {
			return nil, 0, nil
		}
		payloadLen = int(binary.BigEndian.Uint64(data[2:10]))
		offset = 10
	}

	var maskKey []byte
	if masked {
		if len(data) < offset+4 {
			return nil, 0, nil
		}
		maskKey = data[offset : offset+4]
		offset += 4
	}

	total := offset + payloadLen
	if len(data) < total {
		return nil, 0, nil
	}

	payload := make([]byte, payloadLen)
	copy(payload, data[offset:total])
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}

	if onPayload != nil && (opcode == 0x1 || opcode == 0x2 || opcode == 0x0) && len(payload) > 0 {
		onPayload(payload)
	}

	return payload, total, nil
}

type wsInspectReadWriter struct {
	io.ReadWriter
	parser    *wsFrameParser
	onPayload func([]byte)
}

func newWSInspectReadWriter(rw io.ReadWriter, onPayload func([]byte)) *wsInspectReadWriter {
	return &wsInspectReadWriter{
		ReadWriter: rw,
		parser:     &wsFrameParser{},
		onPayload:  onPayload,
	}
}

func (w *wsInspectReadWriter) Read(p []byte) (int, error) {
	n, err := w.ReadWriter.Read(p)
	if n > 0 && w.onPayload != nil {
		func() {
			defer func() { recover() }()
			chunk := p[:n]
			w.parser.Feed(chunk, w.onPayload)
		}()
	}
	return n, err
}

func (w *wsInspectReadWriter) Write(p []byte) (int, error) {
	if len(p) > 0 && w.onPayload != nil {
		func() {
			defer func() { recover() }()
			w.parser.Feed(p, w.onPayload)
		}()
	}
	return w.ReadWriter.Write(p)
}

func (w *wsInspectReadWriter) Close() error {
	if closer, ok := w.ReadWriter.(io.Closer); ok {
		return closer.Close()
	}
	return nil
}
