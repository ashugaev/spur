FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
    git \
    tmux \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# corepack resolves the version from the repo's own `packageManager` field.
# `npm install -g pnpm` pulls latest, whose native binary ships as an optional
# dependency npm can skip, leaving pnpm installed but unrunnable.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install gh -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY . /workspace/spur

RUN useradd -m -s /bin/bash testuser && \
    chown -R testuser:testuser /workspace/spur

RUN mkdir -p /home/testuser/.npm-global && \
    chown -R testuser:testuser /home/testuser/.npm-global
USER testuser
RUN npm config set prefix '/home/testuser/.npm-global'
ENV PATH="/home/testuser/.npm-global/bin:$PATH"

WORKDIR /home/testuser

CMD ["/bin/bash"]
