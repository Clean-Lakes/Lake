FROM debian:bookworm
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update && apt-get install -y --no-install-recommends systemd openssh-server python3 ca-certificates && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* && mkdir -p /run/sshd /etc/lake-fixture /opt/lake-fixture && echo '{"message":"fixture-ok","healthy":true}' > /etc/lake-fixture/config.json
COPY server.py /opt/lake-fixture/server.py
COPY lake-fixture.service /etc/systemd/system/lake-fixture.service
RUN printf 'Port 2222\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nAuthorizedKeysFile /etc/lake-fixture/authorized_keys\nUsePAM no\n' > /etc/ssh/sshd_config.d/lake-fixture.conf && mkdir -p /etc/systemd/system/ssh.service.d && printf '[Service]\nExecStartPre=\nExecStartPre=/usr/bin/ssh-keygen -A\nExecStartPre=/usr/bin/install -m 0600 /run/lake/authorized_keys /etc/lake-fixture/authorized_keys\nExecStartPre=/usr/sbin/sshd -t\n' > /etc/systemd/system/ssh.service.d/keys.conf && systemctl enable ssh lake-fixture.service && systemctl mask systemd-binfmt.service systemd-sysctl.service systemd-modules-load.service
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
