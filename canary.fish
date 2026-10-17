# To opt into canary builds, source this file in your config.fish
# Usage: source /path/to/canary.fish
#
# This puts this checkout's bin/ directory on your PATH, providing a canary-octo
# command that runs octofriend from your current octofriend checkout, allowing you
# to use the main branch without waiting for new octo releases, or to use an
# in-development branch easily.
#
# canary-octo is a real command rather than a shell function so that anything that
# re-runs commands by name can use it, such as Herdr's session restore. The command
# runs the last build; the shell function below passes --compile, so interactive
# runs keep rebuilding from source first.

set -g _OCTOFRIEND_DIR (status dirname)

set -gx PATH "$_OCTOFRIEND_DIR/bin" $PATH

function canary-octo
    command canary-octo --compile $argv
end
