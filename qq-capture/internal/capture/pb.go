package capture

import (
	"encoding/binary"
	"errors"
)

// ProtobufDecoder 简单的 protobuf 解码器
type ProtobufDecoder struct {
	buffer []byte
	offset int
}

// Field 表示 protobuf 字段
type Field struct {
	Number int
	Value  interface{} // 可能是 uint64, []byte, 或 map[int]interface{}
}

// NewProtobufDecoder 创建解码器
func NewProtobufDecoder(buffer []byte) *ProtobufDecoder {
	return &ProtobufDecoder{
		buffer: buffer,
		offset: 0,
	}
}

// Decode 解码 protobuf 数据
func (d *ProtobufDecoder) Decode() (map[int]interface{}, error) {
	result := make(map[int]interface{})

	for d.offset < len(d.buffer) {
		key, err := d.readVarint()
		if err != nil {
			return result, err
		}

		fieldNum := int(key >> 3)
		wireType := int(key & 0x07)

		var value interface{}

		switch wireType {
		case 0: // Varint
			val, err := d.readVarint()
			if err != nil {
				return result, err
			}
			value = val

		case 2: // Length-delimited (string, bytes, embedded message)
			length, err := d.readVarint()
			if err != nil {
				return result, err
			}
			if d.offset+int(length) > len(d.buffer) {
				return result, errors.New("buffer overflow")
			}
			bytes := d.buffer[d.offset : d.offset+int(length)]
			d.offset += int(length)

			// 尝试解码为嵌套消息
			if len(bytes) > 0 {
				nested := NewProtobufDecoder(bytes)
				if nestedResult, err := nested.Decode(); err == nil && len(nestedResult) > 0 {
					value = nestedResult
				} else {
					value = bytes
				}
			} else {
				value = []byte{}
			}

		case 1: // 64-bit
			if d.offset+8 > len(d.buffer) {
				return result, errors.New("buffer overflow")
			}
			value = binary.LittleEndian.Uint64(d.buffer[d.offset : d.offset+8])
			d.offset += 8

		case 5: // 32-bit
			if d.offset+4 > len(d.buffer) {
				return result, errors.New("buffer overflow")
			}
			value = binary.LittleEndian.Uint32(d.buffer[d.offset : d.offset+4])
			d.offset += 4

		default:
			return result, errors.New("unsupported wire type")
		}

		// 处理重复字段
		if existing, ok := result[fieldNum]; ok {
			if arr, ok := existing.([]interface{}); ok {
				result[fieldNum] = append(arr, value)
			} else {
				result[fieldNum] = []interface{}{existing, value}
			}
		} else {
			result[fieldNum] = value
		}
	}

	return result, nil
}

// readVarint 读取 varint
func (d *ProtobufDecoder) readVarint() (uint64, error) {
	var result uint64
	var shift uint
	var b byte

	for {
		if d.offset >= len(d.buffer) {
			return 0, errors.New("unexpected end of buffer")
		}
		b = d.buffer[d.offset]
		d.offset++

		result |= uint64(b&0x7F) << shift
		shift += 7

		if b&0x80 == 0 {
			break
		}
	}

	return result, nil
}

// GetString 从解码结果中提取字符串
func GetString(data map[int]interface{}, fieldNum int) string {
	if val, ok := data[fieldNum]; ok {
		if bytes, ok := val.([]byte); ok {
			return string(bytes)
		}
	}
	return ""
}

// GetMap 从解码结果中提取嵌套消息
func GetMap(data map[int]interface{}, fieldNum int) map[int]interface{} {
	if val, ok := data[fieldNum]; ok {
		if m, ok := val.(map[int]interface{}); ok {
			return m
		}
	}
	return nil
}

// GetArray 从解码结果中提取数组
func GetArray(data map[int]interface{}, fieldNum int) []interface{} {
	if val, ok := data[fieldNum]; ok {
		if arr, ok := val.([]interface{}); ok {
			return arr
		}
		// 单个元素也返回数组
		return []interface{}{val}
	}
	return nil
}

// GetUint64 从解码结果中提取 uint64
func GetUint64(data map[int]interface{}, fieldNum int) uint64 {
	if val, ok := data[fieldNum]; ok {
		if n, ok := val.(uint64); ok {
			return n
		}
	}
	return 0
}
