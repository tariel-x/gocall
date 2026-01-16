frontend:
	rm -f ./internal/static/dist/*
	cd ./frontend/ && npm run build