package ai

import "testing"

func TestCatastrophicCommandBoundary(t *testing.T) {
	for _, command := range []string{
		"rm -rf ./*", "rm -fr -- /", "rm -r .", "rm -rf ~/", "rm -rf /Users/test",
		"sudo -u root /bin/rm --recursive --force ../*", "command rm -rf /var/lib",
		"sudo -n rm -rf /", "command -p rm -rf ./*", "env -S 'rm -rf ./*'", "eval rm -rf ./*", "find -type f -delete",
		"bash -c 'rm -rf ./*'", "echo yes; sh -c 'rm -rf /'", "rm -rf \"$HOME\"",
		"rm -rf $(pwd)", "find . -type f -delete", "find / -delete",
		"find . -exec rm -rf {} \\;", "printf x | xargs rm -rf", "mkfs.ext4 /dev/sda",
		"dd if=/dev/zero of=/dev/disk2", "diskutil eraseDisk APFS empty /dev/disk2",
		"printf x > /dev/sda", "wipefs -a /dev/nvme0n1", "r\\m -rf ./*",
	} {
		if !CatastrophicCommand(command) {
			t.Errorf("missing destructive confirmation: %s", command)
		}
	}
	for _, command := range []string{
		"find ~/Library/Containers -type f -exec stat -f '%Sm %N' {} \\; | sort -r | head -15",
		"rm -- /tmp/disposable.txt", "rm -rf /tmp/specific-build", "mv /tmp/a /tmp/b",
		"rm /tmp/old-*.log", "rm /tmp/report\\*",
		"rm 'report*'", "sh -c 'printf done'", "sudo echo rm -rf ./*", "echo 'rm -rf ./*'",
		"dd if=/tmp/a of=/tmp/b", "diskutil list", "cat /dev/disk2", "echo /dev/sda",
		"fdisk -l /dev/sda", "wipefs /dev/sda", "parted /dev/sda print", "mkfs --help",
		"reboot", "chmod 600 /tmp/specific.txt", "ps aux | awk '{print $1}'", "BOOT=$(sysctl -n kern.boottime); echo $BOOT",
	} {
		if CatastrophicCommand(command) {
			t.Errorf("ordinary command incorrectly requires confirmation: %s", command)
		}
	}
}

func TestSilentCommandsOnlyConfirmCatastrophicCommands(t *testing.T) {
	p := DefaultPermissions()
	p.SilentCommands = true
	for _, name := range []string{"shell", "terminal_execute_command", "ssh_terminal_send", "terminal_send_input", "open_ssh_terminal", "inspect_host", "delete"} {
		kind, err := approvalKind(Config{Permissions: &p}, name, "dangerous", map[string]any{"needsTerminal": true})
		if err != nil || kind != "" {
			t.Errorf("%s ignored silent execution: %q %v", name, kind, err)
		}
		kind, err = approvalKind(Config{Permissions: &p}, name, "dangerous", map[string]any{"catastrophic": true})
		if err != nil || kind != "delete" {
			t.Errorf("%s lost destructive confirmation: %q %v", name, kind, err)
		}
	}
	for _, target := range []string{"/", ".", "/Users/test", "~/Documents"} {
		if !CatastrophicDelete(target) {
			t.Errorf("delete tool bypasses protected root %s", target)
		}
	}
}
