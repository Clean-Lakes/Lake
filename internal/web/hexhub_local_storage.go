package web

// Read only the current HexHub IndexedDB asset store. Never open LevelDB itself:
// Chromium uses a custom comparator, and opening/recovering its live database
// would acquire its lock or write files. Read the manifest, individual tables
// sequentially (no comparer-dependent seeks), and committed WAL batches instead.
import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/golang/snappy"
	"github.com/syndtr/goleveldb/leveldb/journal"
	"github.com/syndtr/goleveldb/leveldb/opt"
	"github.com/syndtr/goleveldb/leveldb/storage"
	"github.com/syndtr/goleveldb/leveldb/table"
)

const hexHubStorageLimit = 64 << 20

var errHexHubStorage = errors.New("HexHub 本地连接数据格式不受支持或读取期间发生变化")

type hexHubBytes struct {
	data []byte
	err  error
}

func (r *hexHubBytes) take(n int) []byte {
	if r.err != nil || n < 0 || n > len(r.data) {
		r.err = errHexHubStorage
		return nil
	}
	v := r.data[:n]
	r.data = r.data[n:]
	return v
}
func (r *hexHubBytes) u() uint64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Uvarint(r.data)
	if n <= 0 {
		r.err = errHexHubStorage
		return 0
	}
	r.data = r.data[n:]
	return v
}
func (r *hexHubBytes) field() []byte {
	n := r.u()
	if n > hexHubStorageLimit {
		r.err = errHexHubStorage
		return nil
	}
	return r.take(int(n))
}
func hexHubReadFile(path string, budget *int) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > int64(*budget) {
		return nil, errHexHubStorage
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errHexHubStorage
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(*budget)+1))
	if err != nil {
		return nil, err
	}
	after, err := f.Stat()
	if err != nil || int64(len(data)) != info.Size() || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return nil, errHexHubStorage
	}
	*budget -= len(data)
	return data, nil
}
func hexHubJournal(data []byte, callback func([]byte) error) error {
	reader := journal.NewReader(bytes.NewReader(data), nil, true, true)
	for {
		record, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return errHexHubStorage
		}
		raw, err := io.ReadAll(io.LimitReader(record, hexHubStorageLimit+1))
		if err != nil || len(raw) > hexHubStorageLimit {
			return errHexHubStorage
		}
		if err = callback(raw); err != nil {
			return err
		}
	}
}

type hexHubManifest struct {
	files     map[uint64]bool
	log, prev uint64
}

func hexHubReadManifest(raw []byte) (hexHubManifest, error) {
	m := hexHubManifest{files: map[uint64]bool{}}
	err := hexHubJournal(raw, func(data []byte) error {
		r := hexHubBytes{data: data}
		for len(r.data) > 0 && r.err == nil {
			switch r.u() {
			case 1:
				if string(r.field()) != "idb_cmp1" {
					return errHexHubStorage
				}
			case 2:
				m.log = r.u()
			case 3, 4:
				r.u()
			case 9:
				m.prev = r.u()
			case 5:
				r.u()
				r.field()
			case 6:
				r.u()
				delete(m.files, r.u())
			case 7:
				r.u()
				number := r.u()
				r.u()
				r.field()
				r.field()
				m.files[number] = true
			default:
				return errHexHubStorage
			}
		}
		return r.err
	})
	return m, err
}

type hexHubKV struct {
	seq     uint64
	deleted bool
	value   []byte
}

func hexHubPrefix(key []byte) (db, store, index uint64, rest []byte) {
	if len(key) == 0 {
		return
	}
	first := key[0]
	a, b, c := int(first>>5)+1, int((first>>2)&7)+1, int(first&3)+1
	if 1+a+b+c > len(key) {
		return
	}
	r := key[1:]
	read := func(n int) uint64 {
		var v uint64
		for i := 0; i < n; i++ {
			v |= uint64(r[i]) << uint(8*i)
		}
		r = r[n:]
		return v
	}
	db, store, index = read(a), read(b), read(c)
	rest = r
	return
}
func hexHubCurrentRecords(ctx context.Context, path string) (map[string]hexHubKV, error) {
	budget := hexHubStorageLimit
	current, err := hexHubReadFile(filepath.Join(path, "CURRENT"), &budget)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(string(current))
	if !strings.HasPrefix(name, "MANIFEST-") || strings.ContainsAny(name, "/\\") {
		return nil, errHexHubStorage
	}
	manifest, err := hexHubReadFile(filepath.Join(path, name), &budget)
	if err != nil {
		return nil, err
	}
	m, err := hexHubReadManifest(manifest)
	if err != nil {
		return nil, err
	}
	records := map[string]hexHubKV{}
	put := func(key, value []byte, seq uint64, deleted bool) error {
		db, store, index, rest := hexHubPrefix(key)
		if db == 0 || !(store != 0 && index == 1 || store == 0 && index == 0 && len(rest) > 0 && rest[0] == 50) {
			return nil
		}
		if len(records) > 20000 {
			return errHexHubStorage
		}
		k := string(key)
		old, exists := records[k]
		if !exists || seq > old.seq {
			records[k] = hexHubKV{seq: seq, deleted: deleted, value: bytes.Clone(value)}
		}
		return nil
	}
	if len(m.files) > 256 {
		return nil, errHexHubStorage
	}
	for number := range m.files {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		file := filepath.Join(path, fmt.Sprintf("%06d.ldb", number))
		if _, err = os.Lstat(file); os.IsNotExist(err) {
			file = filepath.Join(path, fmt.Sprintf("%06d.sst", number))
		}
		raw, err := hexHubReadFile(file, &budget)
		if err != nil {
			return nil, err
		}
		reader, err := table.NewReader(bytes.NewReader(raw), int64(len(raw)), storage.FileDesc{Type: storage.TypeTable, Num: int64(number)}, nil, nil, &opt.Options{Strict: opt.StrictAll})
		if err != nil {
			return nil, errHexHubStorage
		}
		iter := reader.NewIterator(nil, &opt.ReadOptions{Strict: opt.StrictAll})
		for iter.Next() {
			key := iter.Key()
			if len(key) < 8 {
				err = errHexHubStorage
				break
			}
			tag := binary.LittleEndian.Uint64(key[len(key)-8:])
			if tag&255 > 1 {
				err = errHexHubStorage
				break
			}
			if err = put(key[:len(key)-8], iter.Value(), tag>>8, tag&255 == 0); err != nil {
				break
			}
		}
		if err == nil {
			err = iter.Error()
		}
		iter.Release()
		reader.Release()
		if err != nil {
			return nil, errHexHubStorage
		}
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".log" {
			continue
		}
		n, parseErr := strconv.ParseUint(strings.TrimSuffix(entry.Name(), ".log"), 10, 64)
		if parseErr != nil || !(n >= m.log && m.log != 0 || n == m.prev && m.prev != 0) {
			continue
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		raw, err := hexHubReadFile(filepath.Join(path, entry.Name()), &budget)
		if err != nil {
			return nil, err
		}
		err = hexHubJournal(raw, func(data []byte) error {
			if len(data) < 12 {
				return errHexHubStorage
			}
			seq := binary.LittleEndian.Uint64(data)
			count := binary.LittleEndian.Uint32(data[8:])
			if count > 100000 {
				return errHexHubStorage
			}
			r := hexHubBytes{data: data[12:]}
			for i := uint32(0); i < count && r.err == nil; i++ {
				tag := r.take(1)
				if len(tag) != 1 {
					return errHexHubStorage
				}
				key := r.field()
				var value []byte
				if tag[0] == 1 {
					value = r.field()
				} else if tag[0] != 0 {
					return errHexHubStorage
				}
				if r.err != nil {
					return r.err
				}
				if e := put(key, value, seq+uint64(i), tag[0] == 0); e != nil {
					return e
				}
			}
			if r.err != nil || len(r.data) != 0 {
				return errHexHubStorage
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	checkBudget := hexHubStorageLimit
	again, err := hexHubReadFile(filepath.Join(path, name), &checkBudget)
	if err != nil || !bytes.Equal(again, manifest) {
		return nil, errHexHubStorage
	}
	again, err = hexHubReadFile(filepath.Join(path, "CURRENT"), &checkBudget)
	if err != nil || !bytes.Equal(again, current) {
		return nil, errHexHubStorage
	}
	return records, nil
}
func hexHubUTF16(raw []byte, order binary.ByteOrder) (string, error) {
	if len(raw)%2 != 0 {
		return "", errHexHubStorage
	}
	units := make([]uint16, len(raw)/2)
	for i := range units {
		units[i] = order.Uint16(raw[2*i:])
	}
	return string(utf16.Decode(units)), nil
}

// The asset rows use V8's plain objects, arrays, strings, numbers and dates.
// Unsupported host objects fail closed rather than extracting guessed JSON.
type hexHubV8 struct {
	hexHubBytes
	objects []any
	nodes   int
}

func (r *hexHubV8) value(depth int) any {
	r.nodes++
	if depth > 32 || r.nodes > 20000 {
		r.err = errHexHubStorage
		return nil
	}
	tag := r.take(1)
	if len(tag) == 0 {
		return nil
	}
	for tag[0] == 0 {
		tag = r.take(1)
		if len(tag) == 0 {
			return nil
		}
	}
	switch tag[0] {
	case '_', '0', '-':
		return nil
	case 'T':
		return true
	case 'F':
		return false
	case 'I':
		v := r.u()
		return float64(int32(v>>1) ^ -int32(v&1))
	case 'U':
		return float64(r.u())
	case 'N', 'D':
		raw := r.take(8)
		if len(raw) != 8 {
			return nil
		}
		v := math.Float64frombits(binary.LittleEndian.Uint64(raw))
		if math.IsInf(v, 0) || math.IsNaN(v) {
			r.err = errHexHubStorage
		}
		if tag[0] == 'D' {
			r.objects = append(r.objects, v)
		}
		return v
	case '"', 'S', 'c':
		raw := r.field()
		if tag[0] == 'c' {
			v, e := hexHubUTF16(raw, binary.LittleEndian)
			if e != nil {
				r.err = e
			}
			return v
		}
		if tag[0] == '"' {
			chars := make([]rune, len(raw))
			for i, b := range raw {
				chars[i] = rune(b)
			}
			return string(chars)
		}
		if !utf8.Valid(raw) {
			r.err = errHexHubStorage
		}
		return string(raw)
	case '^':
		id := r.u()
		if id >= uint64(len(r.objects)) {
			r.err = errHexHubStorage
			return nil
		}
		return r.objects[id]
	case '?':
		r.u()
		return r.value(depth + 1)
	case 'o':
		obj := Object{}
		r.objects = append(r.objects, obj)
		count := 0
		for r.err == nil && len(r.data) > 0 && r.data[0] != '{' {
			key, ok := r.value(depth + 1).(string)
			if !ok {
				r.err = errHexHubStorage
				return nil
			}
			obj[key] = r.value(depth + 1)
			count++
		}
		end := r.take(1)
		n := r.u()
		if len(end) != 1 || end[0] != '{' || n != uint64(count) {
			r.err = errHexHubStorage
		}
		return obj
	case 'A':
		n := r.u()
		if n > 20000 {
			r.err = errHexHubStorage
			return nil
		}
		arr := make([]any, int(n))
		r.objects = append(r.objects, arr)
		for i := range arr {
			arr[i] = r.value(depth + 1)
		}
		// Array properties are unused by assets, but consume and validate them.
		count := 0
		for r.err == nil && len(r.data) > 0 && r.data[0] != '$' {
			r.value(depth + 1)
			r.value(depth + 1)
			count++
		}
		end := r.take(1)
		p, l := r.u(), r.u()
		if len(end) != 1 || end[0] != '$' || p != uint64(count) || l != n {
			r.err = errHexHubStorage
		}
		return arr
	default:
		r.err = errHexHubStorage
		return nil
	}
}
func hexHubDecodeAsset(raw []byte) (Object, error) {
	r := hexHubBytes{data: raw}
	r.u()
	raw = r.data
	if r.err != nil || len(raw) < 3 {
		return nil, errHexHubStorage
	}
	if bytes.HasPrefix(raw, []byte{255, 17, 2}) {
		n, e := snappy.DecodedLen(raw[3:])
		if e != nil || n > 1<<20 {
			return nil, errHexHubStorage
		}
		raw, e = snappy.Decode(nil, raw[3:])
		if e != nil {
			return nil, errHexHubStorage
		}
	}
	r = hexHubBytes{data: raw}
	if !bytes.Equal(r.take(1), []byte{255}) {
		return nil, errHexHubStorage
	}
	version := r.u()
	if version >= 16 {
		if version >= 21 {
			if !bytes.Equal(r.take(1), []byte{254}) {
				return nil, errHexHubStorage
			}
			trailer := r.take(12)
			if len(trailer) != 12 {
				return nil, errHexHubStorage
			}
			offset := binary.BigEndian.Uint64(trailer)
			if offset != 0 {
				if offset > uint64(len(raw)) || offset < uint64(len(raw)-len(r.data)) {
					return nil, errHexHubStorage
				}
				r.data = raw[len(raw)-len(r.data) : offset]
			}
		}
		if !bytes.Equal(r.take(1), []byte{255}) {
			return nil, errHexHubStorage
		}
		version = r.u()
	}
	if version < 13 || version > 15 || r.err != nil {
		return nil, errHexHubStorage
	}
	v := hexHubV8{hexHubBytes: r}
	value := v.value(0)
	obj, ok := value.(Object)
	if v.err != nil || !ok || len(v.data) != 0 {
		return nil, errHexHubStorage
	}
	return obj, nil
}
func hexHubAssetsFromStorage(ctx context.Context, path string) ([]Object, error) {
	records, err := hexHubCurrentRecords(ctx, path)
	if err != nil {
		return nil, err
	}
	stores := map[[2]uint64]bool{}
	for key, record := range records {
		if record.deleted {
			continue
		}
		db, store, index, rest := hexHubPrefix([]byte(key))
		if store != 0 || index != 0 || len(rest) < 3 || rest[0] != 50 {
			continue
		}
		r := hexHubBytes{data: rest[1:]}
		id := r.u()
		tag := r.take(1)
		if r.err != nil || len(tag) != 1 || tag[0] != 0 {
			continue
		}
		name, e := hexHubUTF16(record.value, binary.BigEndian)
		if e == nil && name == "assets" {
			stores[[2]uint64{db, id}] = true
		}
	}
	if len(stores) != 1 {
		return nil, errHexHubStorage
	}
	out := []Object{}
	for key, record := range records {
		db, store, index, _ := hexHubPrefix([]byte(key))
		if record.deleted || index != 1 || !stores[[2]uint64{db, store}] {
			continue
		}
		obj, e := hexHubDecodeAsset(record.value)
		if e != nil {
			return nil, e
		}
		if obj["delFlag"] == true || integer(obj["delFlag"]) != 0 {
			continue
		}
		switch integer(obj["type"]) {
		case 1, 2, 4, 15, 19:
			out = append(out, obj)
		}
	}
	sort.Slice(out, func(i, j int) bool { return stringOf(out[i]["id"]) < stringOf(out[j]["id"]) })
	return out, nil
}
