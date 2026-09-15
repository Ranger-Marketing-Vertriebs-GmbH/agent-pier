# Exercises our generated formula without installing Homebrew packages or services.
require "pathname"
require "fileutils"
require "json"
require "open3"
class Pathname
  def install(*files)
    mkpath
    files.each { |file| FileUtils.cp_r(file, to_s) }
  end
end
HOMEBREW_PREFIX = Pathname.new(ENV.fetch("FORMULA_PREFIX"))
class Formula
  class << self
    attr_accessor :metadata, :test_body
    def inherited(child); child.metadata = { dependencies: [] }; end
    [:desc, :homepage, :url, :sha256, :license, :version].each do |name|
      define_method(name) { |value| metadata[name] = value }
    end
    def depends_on(value); metadata[:dependencies] << value; end
    def test(&block); self.test_body = block; end
  end
  def libexec; Pathname.new(File.join(Dir.pwd, "installed", "libexec")); end
  def bin; value = Pathname.new(File.join(Dir.pwd, "installed", "bin")); value.mkpath; value; end
  def version; self.class.metadata[:version]; end
  def assert_match(expected, actual); raise "test assertion failed" unless actual.include?(expected.to_s); end
  def shell_output(command)
    stdout, stderr, status = Open3.capture3(command)
    raise stderr unless status.success?
    stdout
  end
end
load ARGV.fetch(0)
formula = AgentpierInstaller.new
formula.install
formula.instance_eval(&AgentpierInstaller.test_body)
result = AgentpierInstaller.metadata.merge(installedVersion: formula.shell_output("#{formula.bin}/agentpier-install --version"))
puts JSON.generate(result)
