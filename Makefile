wasm:
	rm -f ./server/static/web/app.wasm
	GOARCH=wasm GOOS=js go build -o ./server/static/web/app.wasm ./server/internal/web/*.go
	gzip -9 ./server/static/web/app.wasm && mv ./server/static/web/app.wasm.gz ./server/static/web/app.wasm