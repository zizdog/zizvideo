package api

import (
	"bytes"
	"image/png"
	"strings"
	"testing"

	"github.com/makiuchi-d/gozxing"
	gzqrcode "github.com/makiuchi-d/gozxing/qrcode"
	skipqrcode "github.com/skip2/go-qrcode"
)

// 门禁：二维码必须是**整数倍模块**出图，任何内容长度都能被真解码器读出来。
//
// 2026-10-11 抓到的真 bug（不是测试抽风）：老代码 `qrcode.Encode(link, Medium, 512)` 传的是
// **正数**，库内部按 `realSize/size` 做非整数映射 ⇒ 模块在 8px/9px 之间不均；ZXing 的网格
// 估计会飘出图像边界直接 NotFoundException。深链一变长（例如 `u=http://[::1]:<port>`）符号
// 边长就变，于是有一批长度解不出来 —— 表现是**电视扫码没反应**，且只在部分形态上出现。
//
// 这里直接调 qrPNG（线上唯一编码入口），覆盖 40～150 字符多个 QR 版本 + IPv6 形态。
func TestQrImageDecodesAtEveryPayloadLength(t *testing.T) {
	decoded := func(link string) error {
		raw, err := qrPNG(link)
		if err != nil {
			return err
		}
		img, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			return err
		}
		if b := img.Bounds(); b.Dx() != b.Dy() {
			t.Fatalf("二维码不是正方形：%v", b)
		}
		bmp, err := gozxing.NewBinaryBitmapFromImage(img)
		if err != nil {
			return err
		}
		text, err := gzqrcode.NewQRCodeReader().Decode(bmp, nil)
		if err != nil {
			return err
		}
		if text.GetText() != link {
			t.Fatalf("解出来是 %q，期望 %q", text.GetText(), link)
		}
		return nil
	}
	base := "zizvideo://qr?id=" + strings.Repeat("a", 16) + "&s=" + strings.Repeat("b", 26) +
		"&u=http://127.0.0.1:7766/"
	// 出图必须是**整数倍模块**：用 -1 量出符号边长（模块数，含 quiet zone），
	// 真图必须正好是它的 qrScale 倍。老写法（正数 512）在这里就红：512 不是 边长×8。
	crisp := func(link string) {
		t.Helper()
		small, err := skipqrcode.Encode(link, skipqrcode.Medium, -1)
		if err != nil {
			t.Fatal(err)
		}
		unit, err := png.Decode(bytes.NewReader(small))
		if err != nil {
			t.Fatal(err)
		}
		side := unit.Bounds().Dx()
		raw, err := qrPNG(link)
		if err != nil {
			t.Fatal(err)
		}
		got, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if got.Bounds().Dx() != side*qrScale {
			t.Fatalf("二维码不是整数倍模块出图：符号边长 %d 模块，图宽 %d，期望 %d"+
				"（非整数映射会让模块像素数不均，解码器网格估计更易飘）",
				side, got.Bounds().Dx(), side*qrScale)
		}
	}

	for n := 40; n <= 150; n += 3 {
		pad := n - len(base)
		if pad < 0 {
			pad = 0
		}
		link := base + strings.Repeat("x", pad)
		crisp(link)
		if err := decoded(link); err != nil {
			t.Fatalf("%d 字符的深链解不出来（电视上就是这个长度扫不动）：%v", len(link), err)
		}
	}
	ipv6 := "zizvideo://qr?id=abcdefghijklmnop&s=0123456789abcdefghijklmnop&u=http://[::1]:65535"
	crisp(ipv6)
	if err := decoded(ipv6); err != nil {
		t.Fatalf("IPv6 深链解不出来：%v", err)
	}
}
