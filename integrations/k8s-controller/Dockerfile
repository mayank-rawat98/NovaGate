# docker build -t novagate-controller integrations/k8s-controller
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags=-s -o /novagate-controller .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /novagate-controller /novagate-controller
USER 65532:65532
ENTRYPOINT ["/novagate-controller"]
