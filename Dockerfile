FROM alpine/k8s:1.25.8

RUN apk add --no-cache ca-certificates nodejs
RUN helm plugin install https://github.com/instrumenta/helm-kubeval

ENV PYTHONPATH "/usr/lib/python3.10/site-packages/"
COPY . /usr/src/
ENTRYPOINT ["node", "/usr/src/index.js"]
