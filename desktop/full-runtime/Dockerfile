FROM node:22-bookworm-slim
ARG DEBIAN_MIRROR=https://deb.debian.org
RUN node -e "require('fs').writeFileSync('/tmp/bootstrap-ca.pem', require('tls').rootCertificates.join('\n'))" \
    && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::https::CaInfo "/tmp/bootstrap-ca.pem";\nAcquire::https::Timeout "30";\nAcquire::Retries "2";\n' > /etc/apt/apt.conf.d/80agent-bootstrap \
    && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 python3-venv git ripgrep poppler-utils tesseract-ocr tesseract-ocr-chi-sim \
    fonts-noto-cjk libreoffice-writer libreoffice-calc libreoffice-impress \
    && rm -rf /var/lib/apt/lists/* /tmp/bootstrap-ca.pem /etc/apt/apt.conf.d/80agent-bootstrap
ARG PYPI_INDEX_URL=https://pypi.org/simple
RUN python3 -m venv /opt/agent-python \
    && /opt/agent-python/bin/pip install --index-url "${PYPI_INDEX_URL}" --no-cache-dir --timeout=30 --retries=2 \
      openpyxl python-docx python-pptx reportlab pypdf pillow pandas matplotlib \
    && /opt/agent-python/bin/pip freeze > /opt/agent-python/requirements.lock
ENV PATH="/opt/agent-python/bin:${PATH}"
COPY document.py /opt/agent-tools/document.py
COPY document_layout.py /opt/agent-tools/document_layout.py
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/bin/sh"]
