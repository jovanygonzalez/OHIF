.PHONY: package clean

# Package the Node.js proxy for AWS Lambda (nodejs20.x, handler = lambda.handler).
# Includes only production deps (aws4) — no devDependencies, no source maps.
package:
	npm install --production
	@mkdir -p dist
ifeq ($(OS),Windows_NT)
	powershell -NoProfile -Command "if (Test-Path dist/function.zip) { Remove-Item dist/function.zip }; Compress-Archive -Path core.js,lambda.js,package.json,node_modules -DestinationPath dist/function.zip"
else
	rm -f dist/function.zip
	zip -rq dist/function.zip core.js lambda.js package.json node_modules
endif
	@ls -la dist/function.zip

clean:
	rm -rf dist node_modules
